import { createHash, randomBytes } from 'node:crypto';

export const ENVIRONMENT_BOOTSTRAP_PROTOCOL = 'devbridge/environment-bootstrap-v1';
export const ENVIRONMENT_BOOTSTRAP_VERSION = '1.0.0';

const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const REQUEST = /^[a-f0-9]{32}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_REQUIREMENTS = 64;
const MAX_PROTECTED_NAMES = 64;
const MAX_REASON_BYTES = 2_048;
const MAX_RESPONSE_BYTES = 256 * 1024;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function boundedString(value, name, { maxBytes = 4_096, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function targetId(value) {
  if (typeof value !== 'string' || !TARGET.test(value)) throw new TypeError('bootstrap target is invalid');
  return value;
}

function requestId(value = null) {
  if (value == null) return randomBytes(16).toString('hex');
  if (typeof value !== 'string' || !REQUEST.test(value)) throw new TypeError('bootstrap request identity is invalid');
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function normalizeSource(raw) {
  const value = requireObject(raw, 'bootstrap basis.source');
  onlyKeys(value, new Set(['identity', 'revision', 'digest']), 'bootstrap basis.source');
  const digest = String(value.digest ?? '').toLowerCase();
  if (!DIGEST.test(digest)) throw new TypeError('bootstrap basis.source.digest is invalid');
  return {
    identity: safeId(value.identity, 'bootstrap basis.source.identity'),
    revision: safeId(value.revision, 'bootstrap basis.source.revision'),
    digest,
  };
}

function normalizeBasis(raw) {
  const value = requireObject(raw, 'bootstrap basis');
  onlyKeys(value, new Set(['subject', 'generation', 'profile', 'variant', 'source']), 'bootstrap basis');
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new TypeError('bootstrap basis.generation is invalid');
  return {
    subject: boundedString(value.subject, 'bootstrap basis.subject', { maxBytes: 512 }),
    generation: value.generation,
    profile: safeId(value.profile, 'bootstrap basis.profile'),
    variant: safeId(value.variant, 'bootstrap basis.variant'),
    source: normalizeSource(value.source),
  };
}

function normalizePlan(raw) {
  const value = requireObject(raw, 'bootstrap plan');
  onlyKeys(value, new Set(['revision', 'requirements', 'protectedNames', 'networkRequired']), 'bootstrap plan');
  const requirements = value.requirements ?? [];
  if (!Array.isArray(requirements) || requirements.length > MAX_REQUIREMENTS) throw new TypeError('bootstrap plan.requirements is invalid');
  const normalizedRequirements = [...new Set(requirements.map((entry, index) => safeId(entry, `bootstrap plan.requirements[${index}]`)))].sort();
  const protectedNames = value.protectedNames ?? [];
  if (!Array.isArray(protectedNames) || protectedNames.length > MAX_PROTECTED_NAMES) throw new TypeError('bootstrap plan.protectedNames is invalid');
  const normalizedProtected = [...new Set(protectedNames.map((entry, index) => {
    if (typeof entry !== 'string' || !ENV_NAME.test(entry)) throw new TypeError(`bootstrap plan.protectedNames[${index}] is invalid`);
    return entry;
  }))].sort();
  if (value.networkRequired != null && typeof value.networkRequired !== 'boolean') throw new TypeError('bootstrap plan.networkRequired must be boolean');
  return {
    revision: safeId(value.revision, 'bootstrap plan.revision'),
    requirements: normalizedRequirements,
    protectedNames: normalizedProtected,
    networkRequired: value.networkRequired !== false,
  };
}

function normalizeCapability(raw, index) {
  const value = requireObject(raw, `bootstrap observation.capabilities[${index}]`);
  onlyKeys(value, new Set(['id', 'present', 'usable', 'version', 'reason']), `bootstrap observation.capabilities[${index}]`);
  if (typeof value.present !== 'boolean' || typeof value.usable !== 'boolean' || (value.usable && !value.present)) {
    throw new TypeError('bootstrap capability presence/usability is inconsistent');
  }
  return {
    id: safeId(value.id, 'bootstrap capability.id'),
    present: value.present,
    usable: value.usable,
    version: value.version == null ? null : boundedString(value.version, 'bootstrap capability.version', { maxBytes: 512, allowEmpty: true }),
    reason: value.reason == null ? null : boundedString(value.reason, 'bootstrap capability.reason', { maxBytes: MAX_REASON_BYTES }),
  };
}

function normalizeNetwork(raw) {
  const value = requireObject(raw, 'bootstrap observation.network');
  onlyKeys(value, new Set(['nameResolution', 'secureWeb', 'reason']), 'bootstrap observation.network');
  if (typeof value.nameResolution !== 'boolean' || typeof value.secureWeb !== 'boolean') throw new TypeError('bootstrap network observation is invalid');
  return {
    nameResolution: value.nameResolution,
    secureWeb: value.secureWeb,
    reason: value.reason == null ? null : boundedString(value.reason, 'bootstrap observation.network.reason', { maxBytes: MAX_REASON_BYTES }),
  };
}

function normalizeObservation(raw, expected) {
  let serialized;
  try { serialized = JSON.stringify(raw); } catch { throw new TypeError('bootstrap response is not serializable'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) throw new TypeError('bootstrap response is oversized');
  const value = requireObject(raw, 'bootstrap response');
  onlyKeys(value, new Set(['protocol', 'request', 'target', 'action', 'ok', 'body', 'error']), 'bootstrap response');
  if (value.protocol !== ENVIRONMENT_BOOTSTRAP_PROTOCOL || value.request !== expected.request || value.target !== expected.target || value.action !== expected.action) {
    throw new Error('bootstrap response identity does not match the request');
  }
  if (value.ok !== true) {
    const error = requireObject(value.error, 'bootstrap response.error');
    const message = boundedString(error.message ?? 'bootstrap exchange failed', 'bootstrap response.error.message', { maxBytes: MAX_REASON_BYTES });
    throw new Error(message);
  }
  if (value.error != null) throw new Error('successful bootstrap response must not include error');
  const body = requireObject(value.body, 'bootstrap response.body');
  onlyKeys(body, new Set(['generation', 'basisDigest', 'revision', 'network', 'capabilities', 'protectedPresent', 'reason']), 'bootstrap response.body');
  const capabilities = body.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length > MAX_REQUIREMENTS + 32) throw new TypeError('bootstrap observation.capabilities is invalid');
  const normalizedCapabilities = capabilities.map(normalizeCapability);
  const ids = new Set();
  for (const capability of normalizedCapabilities) {
    if (ids.has(capability.id)) throw new TypeError('bootstrap observation contains duplicate capability identities');
    ids.add(capability.id);
  }
  const protectedPresent = body.protectedPresent ?? [];
  if (!Array.isArray(protectedPresent) || protectedPresent.length > MAX_PROTECTED_NAMES) throw new TypeError('bootstrap observation.protectedPresent is invalid');
  const normalizedProtected = protectedPresent.map((entry, index) => {
    if (typeof entry !== 'string' || !ENV_NAME.test(entry)) throw new TypeError(`bootstrap observation.protectedPresent[${index}] is invalid`);
    return entry;
  });
  return {
    generation: body.generation == null ? null : (() => {
      const value = String(body.generation).toLowerCase();
      if (!DIGEST.test(value)) throw new TypeError('bootstrap observation.generation is invalid');
      return value;
    })(),
    basisDigest: body.basisDigest == null ? null : (() => {
      const value = String(body.basisDigest).toLowerCase();
      if (!DIGEST.test(value)) throw new TypeError('bootstrap observation.basisDigest is invalid');
      return value;
    })(),
    revision: body.revision == null ? null : safeId(body.revision, 'bootstrap observation.revision'),
    network: normalizeNetwork(body.network),
    capabilities: normalizedCapabilities.sort((left, right) => left.id.localeCompare(right.id)),
    protectedPresent: [...new Set(normalizedProtected)].sort(),
    reason: body.reason == null ? null : boundedString(body.reason, 'bootstrap observation.reason', { maxBytes: MAX_REASON_BYTES }),
  };
}

function statusFrom(observation, expected) {
  const byId = new Map(observation.capabilities.map((entry) => [entry.id, entry]));
  const missing = expected.plan.requirements.filter((id) => byId.get(id)?.usable !== true);
  const generationReady = observation.generation === expected.generation && observation.basisDigest === expected.basisDigest && observation.revision === expected.plan.revision;
  const networkReady = !expected.plan.networkRequired || (observation.network.nameResolution && observation.network.secureWeb);
  const secretsReady = observation.protectedPresent.length === 0;
  const ready = generationReady && networkReady && missing.length === 0 && secretsReady;
  const reasons = [];
  if (!generationReady) reasons.push('bootstrap generation is not applied to the exact basis');
  if (!networkReady) reasons.push(observation.network.reason ?? 'required network checks are not ready');
  if (missing.length > 0) reasons.push(`required capabilities are unavailable: ${missing.join(', ')}`);
  if (!secretsReady) reasons.push(`protected environment names are present: ${observation.protectedPresent.join(', ')}`);
  if (observation.reason) reasons.push(observation.reason);
  return Object.freeze({
    ready,
    state: ready ? 'ready' : generationReady ? 'degraded' : 'unavailable',
    reason: ready ? null : [...new Set(reasons)].join('; '),
    generation: expected.generation,
    basisDigest: expected.basisDigest,
    revision: expected.plan.revision,
    basis: structuredClone(expected.basis),
    network: Object.freeze({ ...observation.network }),
    capabilities: Object.freeze(observation.capabilities.map((entry) => Object.freeze({ ...entry }))),
    protectedPresent: Object.freeze([...observation.protectedPresent]),
  });
}

function expectedState(basis, plan) {
  const basisDigest = sha256(basis);
  const generation = sha256({ protocol: ENVIRONMENT_BOOTSTRAP_PROTOCOL, version: ENVIRONMENT_BOOTSTRAP_VERSION, basis, plan });
  return { basis, basisDigest, plan, generation };
}

export class EnvironmentBootstrap {
  #basis;
  #plan;
  #prepare;
  #exchange;
  #cycle;
  #settleMs;
  #pollMs;

  constructor({ basis, plan, prepare, exchange, cycle = null, settleMs = 0, pollMs = 1_000 }) {
    if (typeof basis !== 'function') throw new TypeError('bootstrap basis must be a function');
    if (typeof plan !== 'function') throw new TypeError('bootstrap plan must be a function');
    if (typeof prepare !== 'function') throw new TypeError('bootstrap prepare must be a function');
    if (typeof exchange !== 'function') throw new TypeError('bootstrap exchange must be a function');
    if (cycle != null && typeof cycle !== 'function') throw new TypeError('bootstrap cycle must be a function');
    if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 300_000) throw new TypeError('bootstrap settleMs is invalid');
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 30_000) throw new TypeError('bootstrap pollMs is invalid');
    this.#basis = basis;
    this.#plan = plan;
    this.#prepare = prepare;
    this.#exchange = exchange;
    this.#cycle = cycle;
    this.#settleMs = settleMs;
    this.#pollMs = pollMs;
  }

  async #expected(target) {
    const basis = normalizeBasis(await this.#basis(target));
    const plan = normalizePlan(await this.#plan(structuredClone(basis)));
    return expectedState(basis, plan);
  }

  async #send(target, action, expected, { request = null } = {}) {
    const identity = requestId(request);
    const frame = {
      protocol: ENVIRONMENT_BOOTSTRAP_PROTOCOL,
      request: identity,
      target,
      action,
      body: {
        generation: expected.generation,
        basisDigest: expected.basisDigest,
        revision: expected.plan.revision,
        requirements: expected.plan.requirements,
        protectedNames: expected.plan.protectedNames,
        networkRequired: expected.plan.networkRequired,
      },
    };
    const response = await this.#exchange(target, structuredClone(frame));
    return normalizeObservation(response, frame);
  }

  async inspect(rawTarget) {
    const target = targetId(rawTarget);
    const expected = await this.#expected(target);
    const observation = await this.#send(target, 'inspect', expected);
    return statusFrom(observation, expected);
  }

  async ensure(rawTarget) {
    const target = targetId(rawTarget);
    const expected = await this.#expected(target);
    await this.#prepare(target, structuredClone(expected.basis));
    let observation = await this.#send(target, 'inspect', expected);
    let status = statusFrom(observation, expected);
    if (status.ready) return status;
    observation = await this.#send(target, 'apply', expected);
    status = statusFrom(observation, expected);
    if (status.ready) return status;
    const deadline = Date.now() + this.#settleMs;
    while (!status.ready && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.#pollMs, Math.max(1, deadline - Date.now()))));
      observation = await this.#send(target, 'apply', expected);
      status = statusFrom(observation, expected);
    }
    if (!status.ready) throw new Error(status.reason ?? 'bootstrap did not become ready');
    return status;
  }

  async verifyContinuity(rawTarget) {
    const target = targetId(rawTarget);
    if (!this.#cycle) throw new Error('bootstrap continuity check is unavailable');
    const before = await this.ensure(target);
    const beforeBasis = sha256(before.basis);
    await this.#cycle(target);
    const after = await this.ensure(target);
    if (sha256(after.basis) !== beforeBasis || after.generation !== before.generation) {
      throw new Error('bootstrap continuity changed across the lifecycle cycle');
    }
    return after;
  }
}

export function environmentBootstrapGeneration({ basis, plan }) {
  return expectedState(normalizeBasis(basis), normalizePlan(plan)).generation;
}
