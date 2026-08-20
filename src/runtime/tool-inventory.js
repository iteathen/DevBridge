import { createHash } from 'node:crypto';
import process from 'node:process';
import { validateToolProfile } from './cli-profile.js';
import { discoverPathTools } from './tool-discovery.js';
import { operationSecurityDescription } from './deterministic-operation-security.js';
import { profileSecurityDescription, repositoryExecutionReport } from './profile-security.js';

const SHA40_RE = /^[0-9a-f]{40}$/u;
const PARAMETER_SCHEMA_PROTOCOL = 'devbridge/operation-parameters-v1';
const PARAMETER_KINDS = new Set(['flag', 'option', 'positional']);
const PARAMETER_TYPES = new Set(['boolean', 'string', 'project-path', 'integer', 'enum']);

function codepointCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(codepointCompare).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return createHash('sha256').update(stableJson(value), 'utf8').digest('hex'); }
function safeMetadata(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maxLength);
  if (!trimmed || /[\\/]/u.test(trimmed) || /^[A-Za-z]:/u.test(trimmed)) return null;
  return trimmed;
}
function safeSourceClass(value) {
  const source = safeMetadata(value, 80);
  if (!source) return null;
  const lower = source.toLowerCase();
  if (lower === 'path') return 'PATH';
  if (lower === 'current-runtime') return 'current-runtime';
  return 'local-toolchain-discovery';
}
function sanitizeRepositoryExecution(raw) {
  const report = repositoryExecutionReport(raw);
  return {
    state: report.state,
    ready: report.ready,
    identity: safeMetadata(report.identity, 80),
    reason: safeMetadata(report.reason, 240),
  };
}
function sanitizeToolchain(entry) {
  return {
    name: safeMetadata(entry.name, 80), family: safeMetadata(entry.family ?? entry.name, 120),
    layer: safeMetadata(entry.layer ?? 'core', 40) ?? 'core', available: entry.available === true,
    version: safeMetadata(entry.version, 240), source: entry.available === true ? safeSourceClass(entry.source) : null,
    health: entry.available === true ? 'available' : 'unavailable', errorClass: entry.available === true ? null : 'discovery-failed',
  };
}
function sanitizeDiscovered(entry) {
  return { name: safeMetadata(entry.name, 80), category: safeMetadata(entry.category, 80) ?? 'other', available: entry.available === true,
    health: entry.available === true ? 'presence-observed' : 'unavailable', source: entry.available === true ? 'PATH' : null,
    probeStatus: 'not-executed', executableAuthority: false, integrationState: 'informational-only' };
}
function sanitizeParameterSchema(raw) {
  if (!raw || raw.protocol !== PARAMETER_SCHEMA_PROTOCOL || !Array.isArray(raw.parameters) || raw.parameters.length > 64) return null;
  const parameters = [];
  const seen = new Set();
  for (const rawParameter of raw.parameters) {
    if (!rawParameter || typeof rawParameter !== 'object' || Array.isArray(rawParameter)) return null;
    const name = safeMetadata(rawParameter.name, 80);
    if (!name || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(name) || seen.has(name)) return null;
    if (!PARAMETER_KINDS.has(rawParameter.kind) || !PARAMETER_TYPES.has(rawParameter.valueType)) return null;
    if (rawParameter.kind === 'flag' && rawParameter.valueType !== 'boolean') return null;
    if (rawParameter.kind !== 'flag' && rawParameter.valueType === 'boolean') return null;
    const parameter = { name, kind: rawParameter.kind, valueType: rawParameter.valueType, required: rawParameter.required === true, repeat: rawParameter.repeat === true };
    if (parameter.repeat) {
      if (!Number.isSafeInteger(rawParameter.maxItems) || rawParameter.maxItems < 1 || rawParameter.maxItems > 32) return null;
      parameter.maxItems = rawParameter.maxItems;
    }
    if (parameter.valueType === 'enum') {
      if (!Array.isArray(rawParameter.values) || rawParameter.values.length === 0 || rawParameter.values.length > 64) return null;
      const values = rawParameter.values.map((value) => safeMetadata(value, 256));
      if (values.some((value) => value == null)) return null;
      parameter.values = [...new Set(values)];
    }
    seen.add(name);
    parameters.push(parameter);
  }
  return { protocol: PARAMETER_SCHEMA_PROTOCOL, requireAnyParameter: raw.requireAnyParameter === true, parameters };
}
function runtimeProjection(identity) {
  const commitSha = typeof identity?.commitSha === 'string' && SHA40_RE.test(identity.commitSha) ? identity.commitSha : null;
  return { family: 'devbridge', version: safeMetadata(identity?.version, 80), commitSha, nodeFamily: 'node', nodeVersion: safeMetadata(process.version, 80), platform: safeMetadata(process.platform, 40), arch: safeMetadata(process.arch, 40) };
}

export class ToolInventoryService {
  #operations; #toolchains; #repositoryExecution; #profiles; #deterministicProfiles; #modelAdaptersEnabled; #defaultTool; #allowUncontained; #env; #discoverPathToolsEnabled; #runtimeIdentity; #current = null; #generation = 0;
  constructor({ operationRegistry, toolchainRegistry, repositoryExecution = null, profiles = {}, deterministicProfileNames = [], modelAdaptersEnabled = false, defaultTool = null, allowUncontainedTools = false, env = process.env, discoverPathToolsEnabled = true, runtimeIdentity = {} }) {
    if (!operationRegistry || typeof operationRegistry.names !== 'function') throw new TypeError('ToolInventoryService requires an operation registry');
    if (!toolchainRegistry || typeof toolchainRegistry.inspect !== 'function') throw new TypeError('ToolInventoryService requires a toolchain registry');
    this.#operations = operationRegistry; this.#toolchains = toolchainRegistry; this.#repositoryExecution = repositoryExecution;
    if (defaultTool != null && (typeof defaultTool !== 'string' || defaultTool.length === 0)) throw new TypeError('ToolInventoryService defaultTool is invalid');
    this.#profiles = profiles; this.#deterministicProfiles = new Set(deterministicProfileNames); this.#modelAdaptersEnabled = modelAdaptersEnabled === true; this.#defaultTool = defaultTool;
    this.#allowUncontained = allowUncontainedTools === true; this.#env = env; this.#discoverPathToolsEnabled = discoverPathToolsEnabled === true; this.#runtimeIdentity = runtimeIdentity;
  }
  current() { return this.#current ? structuredClone(this.#current) : null; }
  reference() { return this.#current ? { protocol: 'devbridge/tool-inventory-ref-v1', digest: this.#current.digest, generation: this.#current.generation } : null; }
  #status() { return this.#repositoryExecution?.inspect?.() ?? null; }
  #operationInventory(status) {
    const described = typeof this.#operations.describe === 'function' ? this.#operations.describe() : this.#operations.names().map((name) => ({ name, layer: 'core' }));
    return described.map((entry) => {
      const security = operationSecurityDescription(entry.name, status);
      const projected = { name: safeMetadata(entry.name, 80), layer: safeMetadata(entry.layer ?? 'core', 40) ?? 'core', executionClass: security.executionClass,
        repositoryCode: security.repositoryCode === true, repositoryExecutionRequired: security.repositoryExecutionRequired === true,
        executionRequirement: security.executionRequirement, usable: security.usable === true };
      const parameterSchema = sanitizeParameterSchema(entry.parameterSchema); if (parameterSchema) projected.parameterSchema = parameterSchema; return projected;
    });
  }
  async #adapterInventory(status) {
    const entries = [];
    for (const name of Object.keys(this.#profiles).sort(codepointCompare)) {
      const publicName = safeMetadata(name, 80); const raw = this.#profiles[name];
      const adapterClass = this.#deterministicProfiles.has(name) ? 'deterministic-diagnostic' : 'model-adapter';
      let profile;
      try { profile = validateToolProfile(name, raw, { allowUncontainedTools: this.#allowUncontained }); }
      catch { entries.push({ name: publicName, adapterClass, enabled: false, available: false, usable: false, eligibleForAutomaticSelection: false, inputMode: null, declaredPolicy: null, execution: sanitizeRepositoryExecution(status), errorClass: 'profile-invalid' }); continue; }
      const enabled = adapterClass === 'deterministic-diagnostic' || this.#modelAdaptersEnabled;
      const security = profileSecurityDescription(profile, status);
      const execution = { ...sanitizeRepositoryExecution(status), usable: security.execution.usable === true };
      const available = execution.ready === true;
      const usable = enabled && available && execution.usable;
      entries.push({ name: publicName, adapterClass, enabled, available, usable, eligibleForAutomaticSelection: usable && name === this.#defaultTool, inputMode: profile.inputMode,
        declaredPolicy: security.declaredPolicy, execution, errorClass: available ? null : 'repository-execution-unavailable' });
    }
    return entries;
  }
  async refresh({ refreshToolchains = false } = {}) {
    const status = this.#status();
    const repositoryExecution = sanitizeRepositoryExecution(status);
    const toolchains = (await this.#toolchains.inspect({ refresh: refreshToolchains })).map(sanitizeToolchain).sort((a, b) => codepointCompare(a.name ?? '', b.name ?? ''));
    const discovery = this.#discoverPathToolsEnabled ? await discoverPathTools({ env: this.#env }) : { tools: [], discoveryElapsedMs: 0, directoriesScanned: 0, pathTruncated: false };
    const normalized = { protocol: 'devbridge/tool-inventory-v1', authority: 'local-observation-only', runtime: runtimeProjection(this.#runtimeIdentity), repositoryExecution,
      operations: this.#operationInventory(status), toolchains, adapters: await this.#adapterInventory(status), discoveredTools: discovery.tools.map(sanitizeDiscovered),
      discovery: { mode: 'presence-only-no-execution', directoriesScanned: discovery.directoriesScanned, pathTruncated: discovery.pathTruncated === true } };
    const inventoryDigest = digest(normalized); if (this.#current?.digest === inventoryDigest) return this.current();
    this.#generation += 1; this.#current = { protocol: 'devbridge/tool-inventory-record-v1', digest: inventoryDigest, generation: this.#generation, generatedAt: new Date().toISOString(), discoveryElapsedMs: discovery.discoveryElapsedMs, inventory: normalized };
    return this.current();
  }
}

export function toolInventoryDigest(value) { return digest(value); }
