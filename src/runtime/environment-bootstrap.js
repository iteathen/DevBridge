import { createHash } from 'node:crypto';

export const ENVIRONMENT_BOOTSTRAP_PROTOCOL = 'devbridge/environment-bootstrap-v1';

const SAFE_TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_CHECKS = 32;
const MAX_VARIANTS = 8;
const MAX_ARGUMENTS = 16;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function targetToken(value) {
  if (typeof value !== 'string' || !SAFE_TARGET.test(value)) throw new TypeError('bootstrap target must be an opaque local token');
  return value;
}

function boundedString(value, name, maxBytes = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function codepointCompare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(codepointCompare).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizeBasis(raw) {
  const value = requireObject(raw, 'bootstrap basis');
  onlyKeys(value, new Set(['identity', 'revision', 'digest']), 'bootstrap basis');
  const identity = boundedString(value.identity, 'bootstrap basis.identity', 256);
  const revision = boundedString(value.revision, 'bootstrap basis.revision', 256);
  const digest = String(value.digest ?? '').toLowerCase();
  if (!DIGEST.test(digest)) throw new TypeError('bootstrap basis.digest must be a sha256 digest');
  return { identity, revision, digest };
}

function normalizeVariant(raw, checkIndex, variantIndex) {
  const value = requireObject(raw, `bootstrap checks[${checkIndex}].variants[${variantIndex}]`);
  onlyKeys(value, new Set(['program', 'arguments']), `bootstrap checks[${checkIndex}].variants[${variantIndex}]`);
  if (typeof value.program !== 'string' || !SAFE_NAME.test(value.program) || /[\\/]/u.test(value.program)) {
    throw new TypeError(`bootstrap checks[${checkIndex}].variants[${variantIndex}].program must be a logical executable identity`);
  }
  const args = value.arguments ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS || args.some((entry) => typeof entry !== 'string' || entry.includes('\0') || Buffer.byteLength(entry, 'utf8') > 1024)) {
    throw new TypeError(`bootstrap checks[${checkIndex}].variants[${variantIndex}].arguments is invalid`);
  }
  return { program: value.program, arguments: [...args] };
}

function normalizeCheck(raw, index) {
  const value = requireObject(raw, `bootstrap checks[${index}]`);
  onlyKeys(value, new Set(['name', 'variants']), `bootstrap checks[${index}]`);
  if (typeof value.name !== 'string' || !SAFE_NAME.test(value.name)) throw new TypeError(`bootstrap checks[${index}].name is invalid`);
  if (!Array.isArray(value.variants) || value.variants.length === 0 || value.variants.length > MAX_VARIANTS) {
    throw new TypeError(`bootstrap checks[${index}].variants must contain 1-${MAX_VARIANTS} entries`);
  }
  return { name: value.name, variants: value.variants.map((entry, variantIndex) => normalizeVariant(entry, index, variantIndex)) };
}

function normalizeConnectivity(raw) {
  const value = requireObject(raw, 'bootstrap connectivity');
  onlyKeys(value, new Set(['host', 'url']), 'bootstrap connectivity');
  const host = boundedString(value.host, 'bootstrap connectivity.host', 253).toLowerCase();
  if (!/^[A-Za-z0-9.-]+$/u.test(host) || host.startsWith('.') || host.endsWith('.')) throw new TypeError('bootstrap connectivity.host is invalid');
  let url;
  try { url = new URL(boundedString(value.url, 'bootstrap connectivity.url', 2048)); }
  catch { throw new TypeError('bootstrap connectivity.url is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new TypeError('bootstrap connectivity.url must be direct HTTPS without credentials');
  return { host, url: url.toString() };
}

export function normalizeBootstrapDeclaration(raw) {
  const value = requireObject(raw, 'bootstrap declaration');
  onlyKeys(value, new Set(['basis', 'checks', 'connectivity']), 'bootstrap declaration');
  if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > MAX_CHECKS) {
    throw new TypeError(`bootstrap checks must contain 1-${MAX_CHECKS} entries`);
  }
  const checks = value.checks.map(normalizeCheck);
  if (new Set(checks.map((entry) => entry.name)).size !== checks.length) throw new TypeError('bootstrap check names must be unique');
  return { basis: normalizeBasis(value.basis), checks, connectivity: normalizeConnectivity(value.connectivity) };
}

export function bootstrapGeneration(raw) {
  const declaration = normalizeBootstrapDeclaration(raw);
  return createHash('sha256').update(stableJson({ protocol: ENVIRONMENT_BOOTSTRAP_PROTOCOL, declaration }), 'utf8').digest('hex');
}

function normalizeCapability(raw, expectedName) {
  const value = requireObject(raw, `bootstrap capability ${expectedName}`);
  onlyKeys(value, new Set(['name', 'present', 'usable', 'version', 'reason']), `bootstrap capability ${expectedName}`);
  if (value.name !== expectedName) throw new Error('bootstrap capability identity changed');
  if (typeof value.present !== 'boolean' || typeof value.usable !== 'boolean' || (value.usable && !value.present)) throw new TypeError('bootstrap capability state is invalid');
  const version = value.version == null ? null : boundedString(String(value.version), 'bootstrap capability.version', 512);
  const reason = value.reason == null ? null : boundedString(String(value.reason), 'bootstrap capability.reason', 2048);
  if (!value.usable && !reason) throw new TypeError('bootstrap capability requires a reason when unusable');
  return Object.freeze({ name: expectedName, present: value.present, usable: value.usable, version, reason });
}

function normalizeNetworkEntry(raw, name) {
  const value = requireObject(raw, `bootstrap network.${name}`);
  onlyKeys(value, new Set(['usable', 'reason']), `bootstrap network.${name}`);
  if (typeof value.usable !== 'boolean') throw new TypeError(`bootstrap network.${name}.usable must be boolean`);
  const reason = value.reason == null ? null : boundedString(String(value.reason), `bootstrap network.${name}.reason`, 2048);
  if (!value.usable && !reason) throw new TypeError(`bootstrap network.${name} requires a reason when unusable`);
  return Object.freeze({ usable: value.usable, reason });
}

function normalizeObservation(raw, target, declaration, generation) {
  const value = requireObject(raw, 'bootstrap observation');
  onlyKeys(value, new Set(['protocol', 'generation', 'applied', 'network', 'capabilities', 'isolation']), 'bootstrap observation');
  if (value.protocol !== ENVIRONMENT_BOOTSTRAP_PROTOCOL) throw new Error('bootstrap observation protocol is incompatible');
  if (value.generation !== generation) throw new Error('bootstrap observation generation changed');
  if (typeof value.applied !== 'boolean') throw new TypeError('bootstrap observation.applied must be boolean');
  const network = requireObject(value.network, 'bootstrap observation.network');
  onlyKeys(network, new Set(['dns', 'https']), 'bootstrap observation.network');
  const normalizedNetwork = Object.freeze({ dns: normalizeNetworkEntry(network.dns, 'dns'), https: normalizeNetworkEntry(network.https, 'https') });
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== declaration.checks.length) throw new TypeError('bootstrap observation capabilities do not match the declaration');
  const byName = new Map(value.capabilities.map((entry) => [entry?.name, entry]));
  if (byName.size !== value.capabilities.length) throw new TypeError('bootstrap observation capability names are duplicated');
  const capabilities = declaration.checks.map((entry) => normalizeCapability(byName.get(entry.name), entry.name));
  const isolation = requireObject(value.isolation, 'bootstrap observation.isolation');
  onlyKeys(isolation, new Set(['clean', 'unexpectedNames']), 'bootstrap observation.isolation');
  if (typeof isolation.clean !== 'boolean' || !Array.isArray(isolation.unexpectedNames) || isolation.unexpectedNames.length > 64 || isolation.unexpectedNames.some((entry) => typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(entry))) {
    throw new TypeError('bootstrap observation isolation state is invalid');
  }
  if (isolation.clean !== (isolation.unexpectedNames.length === 0)) throw new TypeError('bootstrap observation isolation aggregate is inconsistent');
  const ready = value.applied && normalizedNetwork.dns.usable && normalizedNetwork.https.usable && isolation.clean && capabilities.every((entry) => entry.usable);
  return Object.freeze({ protocol: ENVIRONMENT_BOOTSTRAP_PROTOCOL, target, generation, ready, basis: Object.freeze({ ...declaration.basis }), network: normalizedNetwork, capabilities: Object.freeze(capabilities), isolation: Object.freeze({ clean: isolation.clean, unexpectedNames: Object.freeze([...isolation.unexpectedNames]) }) });
}

function assertPort(value, name) {
  if (typeof value !== 'function') throw new TypeError(`bootstrap ${name} port must be a function`);
  return value;
}

export class EnvironmentBootstrap {
  #prepare;
  #exchange;
  #restart;

  constructor({ prepare, exchange, restart }) {
    this.#prepare = assertPort(prepare, 'prepare');
    this.#exchange = assertPort(exchange, 'exchange');
    this.#restart = assertPort(restart, 'restart');
  }

  async #observe(target, declaration, generation, operation) {
    const raw = await this.#exchange(target, { protocol: ENVIRONMENT_BOOTSTRAP_PROTOCOL, operation, generation, declaration });
    return normalizeObservation(raw, target, declaration, generation);
  }

  async ensure(rawTarget, rawDeclaration) {
    const target = targetToken(rawTarget);
    const declaration = normalizeBootstrapDeclaration(rawDeclaration);
    const generation = bootstrapGeneration(declaration);
    const prepared = requireObject(await this.#prepare(target, { generation, basis: { ...declaration.basis } }), 'bootstrap prepare result');
    onlyKeys(prepared, new Set(['ready', 'reason']), 'bootstrap prepare result');
    if (prepared.ready !== true) throw new Error(String(prepared.reason ?? 'bootstrap target preparation did not become ready'));
    return this.#observe(target, declaration, generation, 'apply');
  }

  async inspect(rawTarget, rawDeclaration) {
    const target = targetToken(rawTarget);
    const declaration = normalizeBootstrapDeclaration(rawDeclaration);
    const generation = bootstrapGeneration(declaration);
    return this.#observe(target, declaration, generation, 'observe');
  }

  async cycle(rawTarget, rawDeclaration) {
    const target = targetToken(rawTarget);
    const before = await this.ensure(target, rawDeclaration);
    if (!before.ready) return { before, after: null, stable: false };
    const restarted = requireObject(await this.#restart(target), 'bootstrap restart result');
    onlyKeys(restarted, new Set(['identity', 'ready', 'reason']), 'bootstrap restart result');
    if (restarted.identity !== target) throw new Error('bootstrap target identity changed across restart');
    if (restarted.ready !== true) throw new Error(String(restarted.reason ?? 'bootstrap target did not become ready after restart'));
    const after = await this.inspect(target, rawDeclaration);
    return { before, after, stable: before.generation === after.generation && after.ready };
  }
}
