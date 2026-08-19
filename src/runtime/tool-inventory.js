import { createHash } from 'node:crypto';
import process from 'node:process';
import { validateToolProfile } from './cli-profile.js';
import { discoverPathTools } from './tool-discovery.js';
import { resolveExecutable } from './executable-resolver.js';
import { operationSecurityDescription } from './deterministic-operation-security.js';
import { enforcementProviderReport, profileSecurityDescription } from './profile-security.js';

const SHA40_RE = /^[0-9a-f]{40}$/u;

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(codepointCompare).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function safeMetadata(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maxLength);
  if (!trimmed) return null;
  // Remote inventory must not become a machine-path disclosure channel.
  if (/[\\/]/u.test(trimmed) || /^[A-Za-z]:/u.test(trimmed)) return null;
  return trimmed;
}

function safeSourceClass(value) {
  const source = safeMetadata(value, 80);
  if (!source) return null;
  const lower = source.toLowerCase();
  if (lower === 'path') return 'PATH';
  if (lower === 'current-runtime') return 'current-runtime';
  if (lower.includes('visual studio') || lower.includes('vswhere')) return 'local-toolchain-discovery';
  if (lower.includes('local')) return 'local-toolchain-discovery';
  return 'local-toolchain-discovery';
}

function sanitizeEnforcement(raw) {
  const report = enforcementProviderReport(raw);
  return {
    requestedProvider: safeMetadata(report.requestedProvider, 40),
    provider: safeMetadata(report.provider, 40) ?? 'none',
    platform: safeMetadata(report.platform, 40),
    available: report.available === true,
    verified: report.verified === true,
    verification: safeMetadata(report.verification, 80) ?? 'unavailable',
    repositoryCodeExecution: report.repositoryCodeExecution === true,
    filesystem: safeMetadata(report.filesystem, 80) ?? 'unverified',
    network: safeMetadata(report.network, 80) ?? 'unverified',
    gitAdministrativeState: safeMetadata(report.gitAdministrativeState, 80) ?? 'unverified',
    processTree: safeMetadata(report.processTree, 80) ?? 'unverified',
  };
}

function sanitizeToolchain(entry) {
  return {
    name: safeMetadata(entry.name, 80),
    family: safeMetadata(entry.family ?? entry.name, 120),
    layer: safeMetadata(entry.layer ?? 'core', 40) ?? 'core',
    available: entry.available === true,
    version: safeMetadata(entry.version, 240),
    source: entry.available === true ? safeSourceClass(entry.source) : null,
    health: entry.available === true ? 'available' : 'unavailable',
    errorClass: entry.available === true ? null : 'discovery-failed',
  };
}

function sanitizeDiscovered(entry) {
  return {
    name: safeMetadata(entry.name, 80),
    category: safeMetadata(entry.category, 80) ?? 'other',
    available: entry.available === true,
    health: entry.available === true ? 'presence-observed' : 'unavailable',
    source: entry.available === true ? 'PATH' : null,
    probeStatus: 'not-executed',
    executableAuthority: false,
    integrationState: 'informational-only',
  };
}

function runtimeProjection(identity) {
  const commitSha = typeof identity?.commitSha === 'string' && SHA40_RE.test(identity.commitSha)
    ? identity.commitSha
    : null;
  return {
    family: 'patch-poller',
    version: safeMetadata(identity?.version, 80),
    commitSha,
    nodeFamily: 'node',
    nodeVersion: safeMetadata(process.version, 80),
    platform: safeMetadata(process.platform, 40),
    arch: safeMetadata(process.arch, 40),
  };
}

export class ToolInventoryService {
  #operations;
  #toolchains;
  #sandbox;
  #profiles;
  #deterministicProfiles;
  #modelAdaptersEnabled;
  #allowUncontained;
  #env;
  #discoverPathToolsEnabled;
  #runtimeIdentity;
  #current = null;
  #generation = 0;

  constructor({
    operationRegistry,
    toolchainRegistry,
    sandboxProvider,
    profiles = {},
    deterministicProfileNames = [],
    modelAdaptersEnabled = false,
    allowUncontainedTools = false,
    env = process.env,
    discoverPathToolsEnabled = true,
    runtimeIdentity = {},
  }) {
    if (!operationRegistry || typeof operationRegistry.names !== 'function') throw new TypeError('ToolInventoryService requires an operation registry');
    if (!toolchainRegistry || typeof toolchainRegistry.inspect !== 'function') throw new TypeError('ToolInventoryService requires a toolchain registry');
    this.#operations = operationRegistry;
    this.#toolchains = toolchainRegistry;
    this.#sandbox = sandboxProvider;
    this.#profiles = profiles;
    this.#deterministicProfiles = new Set(deterministicProfileNames);
    this.#modelAdaptersEnabled = modelAdaptersEnabled === true;
    this.#allowUncontained = allowUncontainedTools === true;
    this.#env = env;
    this.#discoverPathToolsEnabled = discoverPathToolsEnabled === true;
    this.#runtimeIdentity = runtimeIdentity;
  }

  current() {
    return this.#current ? structuredClone(this.#current) : null;
  }

  reference() {
    if (!this.#current) return null;
    return {
      protocol: 'patch-poller/tool-inventory-ref-v1',
      digest: this.#current.digest,
      generation: this.#current.generation,
    };
  }

  #operationInventory(sandboxStatus) {
    return this.#operations.names().map((name) => {
      const security = operationSecurityDescription(name, sandboxStatus);
      return {
        name,
        layer: 'core',
        executionClass: security.executionClass,
        repositoryCode: security.repositoryCode === true,
        sandboxRequired: security.sandboxRequired === true,
        enforcementRequirement: security.enforcementRequirement,
        usable: security.usable === true,
      };
    });
  }

  async #adapterInventory(sandboxStatus) {
    const entries = [];
    for (const name of Object.keys(this.#profiles).sort(codepointCompare)) {
      const raw = this.#profiles[name];
      const adapterClass = this.#deterministicProfiles.has(name) ? 'deterministic-diagnostic' : 'model-adapter';
      let profile;
      try {
        profile = validateToolProfile(name, raw, { allowUncontainedTools: this.#allowUncontained });
      } catch {
        entries.push({
          name,
          adapterClass,
          enabled: false,
          available: false,
          usable: false,
          eligibleForAutomaticSelection: false,
          inputMode: null,
          declaredPolicy: null,
          enforcement: sanitizeEnforcement(sandboxStatus),
          errorClass: 'profile-invalid',
        });
        continue;
      }

      let available = false;
      try {
        await resolveExecutable(profile.executable, this.#env);
        available = true;
      } catch {
        available = false;
      }
      const enabled = adapterClass === 'deterministic-diagnostic' || this.#modelAdaptersEnabled;
      const security = profileSecurityDescription(profile, sandboxStatus);
      const enforcement = sanitizeEnforcement({
        ...sandboxStatus,
        ...security.enforcement,
        verified: security.enforcement.verified === true,
      });
      const usable = enabled && available && security.enforcement.usable === true;
      entries.push({
        name,
        adapterClass,
        enabled,
        available,
        usable,
        eligibleForAutomaticSelection: usable && adapterClass === 'model-adapter',
        inputMode: profile.inputMode,
        declaredPolicy: security.declaredPolicy,
        enforcement,
        errorClass: available ? null : 'executable-unavailable',
      });
    }
    return entries;
  }

  async refresh({ verifySandbox = false } = {}) {
    let sandboxStatus;
    if (verifySandbox && this.#sandbox?.verify) sandboxStatus = await this.#sandbox.verify();
    else sandboxStatus = this.#sandbox?.inspect?.() ?? null;
    const normalizedSandbox = sanitizeEnforcement(sandboxStatus);
    const toolchains = (await this.#toolchains.inspect())
      .map(sanitizeToolchain)
      .sort((a, b) => codepointCompare(a.name ?? '', b.name ?? ''));
    const discovery = this.#discoverPathToolsEnabled
      ? await discoverPathTools({ env: this.#env })
      : { tools: [], discoveryElapsedMs: 0, directoriesScanned: 0, pathTruncated: false };
    const normalized = {
      protocol: 'patch-poller/tool-inventory-v1',
      authority: 'local-observation-only',
      runtime: runtimeProjection(this.#runtimeIdentity),
      enforcement: normalizedSandbox,
      operations: this.#operationInventory(sandboxStatus),
      toolchains,
      adapters: await this.#adapterInventory(sandboxStatus),
      discoveredTools: discovery.tools.map(sanitizeDiscovered),
      discovery: {
        mode: 'presence-only-no-execution',
        directoriesScanned: discovery.directoriesScanned,
        pathTruncated: discovery.pathTruncated === true,
      },
    };
    const inventoryDigest = digest(normalized);
    if (this.#current?.digest === inventoryDigest) return this.current();
    this.#generation += 1;
    this.#current = {
      protocol: 'patch-poller/tool-inventory-record-v1',
      digest: inventoryDigest,
      generation: this.#generation,
      generatedAt: new Date().toISOString(),
      discoveryElapsedMs: discovery.discoveryElapsedMs,
      inventory: normalized,
    };
    return this.current();
  }
}

export function toolInventoryDigest(value) {
  return digest(value);
}
