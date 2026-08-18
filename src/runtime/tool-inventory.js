import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';
import { validateToolProfile } from './cli-profile.js';
import { resolveExecutable } from './executable-resolver.js';
import { sanitizeDiscoveredRegistry } from './tool-discovery.js';

const COMMIT_RE = /^[0-9a-f]{40}$/u;
const WINDOWS_ABSOLUTE_RE = /(?:^|[\s"'=(])(?:[A-Za-z]:\\|\\\\)[^\s"']*/u;
const POSIX_HOME_RE = /(?:^|[\s"'=(])\/(?:home|Users|root|private|var\/folders)\//u;
const MAX_VERSION = 300;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function bounded(value, max = MAX_VERSION) {
  if (value == null) return null;
  const text = String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (WINDOWS_ABSOLUTE_RE.test(text) || POSIX_HOME_RE.test(text) || path.isAbsolute(text)) return null;
  return text.length <= max ? text : text.slice(0, max);
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (['generatedAt', 'probedAt', 'lastProbeAt', 'elapsedMs'].includes(key)) continue;
    result[key] = stripVolatile(entry);
  }
  return result;
}

function assertNoSensitivePaths(value, cursor = 'inventory') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertNoSensitivePaths(value[index], `${cursor}[${index}]`);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:executable|path|directory|home|token|secret|credential|environment|args)$/iu.test(key)) {
        throw new PolicyError(`tool inventory projection contains forbidden field ${cursor}.${key}`);
      }
      assertNoSensitivePaths(entry, `${cursor}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && (WINDOWS_ABSOLUTE_RE.test(value) || POSIX_HOME_RE.test(value) || path.isAbsolute(value))) {
    throw new PolicyError(`tool inventory projection contains an absolute machine path at ${cursor}`);
  }
}

async function runtimeIdentity(env) {
  let version = null;
  try {
    const packageUrl = new URL('../../package.json', import.meta.url);
    const parsed = JSON.parse(await readFile(packageUrl, 'utf8'));
    version = bounded(parsed?.version, 80);
  } catch {
    version = null;
  }
  const commit = COMMIT_RE.test(env.PATCH_POLLER_RUNTIME_COMMIT ?? '') ? env.PATCH_POLLER_RUNTIME_COMMIT : null;
  return { family: 'patch-poller', version, commit };
}

async function adapterInventory({ tools, modelAdaptersEnabled, deterministicProfileNames, allowUncontainedTools, sandboxStatus, env }) {
  const reserved = new Set(deterministicProfileNames);
  const entries = [];
  for (const name of Object.keys(tools).sort()) {
    let profile;
    try {
      profile = validateToolProfile(name, tools[name], {
        allowUncontainedTools,
        allowControlOwnedTools: reserved.has(name),
      });
    } catch (error) {
      entries.push({ name, layer: reserved.has(name) ? 'control-diagnostic' : 'model-adapter', enabled: false, available: false, usable: false, health: 'invalid-profile', errorClass: error.name });
      continue;
    }
    let available = false;
    try {
      await resolveExecutable(profile.executable, env);
      available = true;
    } catch {
      available = false;
    }
    const controlOwned = profile.controlOwned === true;
    const enabled = controlOwned || modelAdaptersEnabled;
    const unsafeOverride = !controlOwned && profile.sandbox.enforcement === 'none' && allowUncontainedTools;
    const enforcement = controlOwned
      ? { provider: 'control-owned', verified: false, satisfied: true, controlOwned: true, reason: 'fixed-patch-poller-code' }
      : {
          provider: sandboxStatus.provider,
          verified: sandboxStatus.verified === true,
          satisfied: sandboxStatus.verified === true || unsafeOverride,
          unsafeOverride,
          reason: sandboxStatus.reason ?? null,
        };
    entries.push({
      name,
      layer: controlOwned ? 'control-diagnostic' : 'model-adapter',
      enabled,
      available,
      usable: enabled && available && enforcement.satisfied,
      health: available ? 'resolved' : 'unavailable',
      inputMode: profile.inputMode,
      resultProtocol: 'patch-poller/result-v1',
      declaredPolicy: {
        enforcement: profile.sandbox.enforcement,
        outsideProjectRead: profile.sandbox.outsideProjectRead,
        outsideProjectWrite: profile.sandbox.outsideProjectWrite,
        network: profile.sandbox.network,
      },
      verifiedEnforcement: enforcement,
      eligibleForAutomaticSelection: enabled && available && enforcement.satisfied,
    });
  }
  return entries;
}

export async function buildToolInventory({
  operationRegistry,
  toolchainRegistry,
  tools = {},
  deterministicProfileNames = [],
  modelAdaptersEnabled = false,
  allowUncontainedTools = false,
  sandboxManager,
  discoveredRegistry = null,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  refresh = false,
}) {
  const generatedAt = new Date().toISOString();
  const sandboxStatus = sandboxManager
    ? await sandboxManager.inspect({ refresh })
    : { provider: 'none', configured: false, available: false, verified: false, reason: 'no-provider-configured', boundaries: null };
  const toolchains = await toolchainRegistry.inspect({ refresh });
  const operations = operationRegistry.describe().map((operation) => ({
    name: operation.name,
    layer: operation.layer,
    executionClass: operation.executionClass,
    requiredEnforcement: operation.requiredEnforcement,
    enforcementSatisfied: operation.requiredEnforcement === 'none' || sandboxStatus.verified === true,
  }));
  const adapters = await adapterInventory({
    tools,
    modelAdaptersEnabled,
    deterministicProfileNames,
    allowUncontainedTools,
    sandboxStatus,
    env,
  });
  const discovered = sanitizeDiscoveredRegistry(discoveredRegistry);
  if (discovered) {
    for (const entry of discovered.entries) entry.version = bounded(entry.version);
  }
  const inventory = {
    protocol: 'patch-poller/tool-inventory-v1',
    generatedAt,
    runtime: await runtimeIdentity(env),
    host: { platform, arch },
    sandbox: {
      configuredProvider: sandboxStatus.provider,
      configured: sandboxStatus.configured === true,
      available: sandboxStatus.available === true,
      verified: sandboxStatus.verified === true,
      reason: bounded(sandboxStatus.reason, 100),
      boundaries: sandboxStatus.boundaries ?? null,
    },
    operations,
    toolchains: toolchains.map((entry) => ({
      name: entry.name,
      family: bounded(entry.family, 80),
      available: entry.available === true,
      health: entry.health,
      version: bounded(entry.version),
      source: bounded(entry.source, 80),
      probedAt: entry.probedAt ?? null,
      errorClass: bounded(entry.errorClass, 80),
    })),
    adapters,
    discovered,
  };
  const normalized = stripVolatile(inventory);
  inventory.digest = digest(normalized);
  inventory.generation = inventory.digest.slice(0, 16);
  assertNoSensitivePaths(inventory);
  return inventory;
}

export function toolInventoryDigest(inventory) {
  if (!inventory || inventory.protocol !== 'patch-poller/tool-inventory-v1') throw new PolicyError('tool inventory protocol is invalid');
  const copy = structuredClone(inventory);
  delete copy.digest;
  delete copy.generation;
  return digest(stripVolatile(copy));
}

export function assertSafeToolInventoryProjection(inventory) {
  assertNoSensitivePaths(inventory);
  if (toolInventoryDigest(inventory) !== inventory.digest) throw new PolicyError('tool inventory digest mismatch');
  return true;
}
