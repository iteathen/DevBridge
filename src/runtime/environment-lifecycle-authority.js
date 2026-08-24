import { randomUUID } from 'node:crypto';

const REQUEST_PROTOCOL = 'devbridge/environment-lifecycle-authority-request-v1';
const RESULT_PROTOCOL = 'devbridge/environment-lifecycle-authority-result-v1';
const ENVIRONMENT_ID = /^env-[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const MAX_SUBJECT_BYTES = 512;
const MAX_ENVELOPE_BYTES = 16 * 1024;
const MIN_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_PROCESSORS = 256;
const OPERATIONS = new Set([
  'ensure',
  'list',
  'observe',
  'start',
  'stop',
  'reset',
  'reseed',
  'remove',
  'reconcile',
  'protected-source-identities',
  'rebuild',
  'replace',
  'recreate',
  'retire-superseded',
]);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function requireSafeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function requireEnvironmentId(value, name = 'environment identity') {
  if (typeof value !== 'string' || !ENVIRONMENT_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function requireRequestId(value, name = 'authority request identity') {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeSubject(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_SUBJECT_BYTES) {
    throw new TypeError('environment subject must be a bounded opaque identity');
  }
  return value;
}

function normalizeSettings(raw = {}) {
  const value = requireObject(raw, 'environment settings');
  onlyKeys(value, new Set(['memoryBytes', 'processorCount', 'firmware']), 'environment settings');
  const memoryBytes = value.memoryBytes ?? 2 * 1024 * 1024 * 1024;
  const processorCount = value.processorCount ?? 2;
  const firmware = value.firmware ?? 'efi';
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < MIN_MEMORY_BYTES || memoryBytes > MAX_MEMORY_BYTES) throw new TypeError('environment settings.memoryBytes is invalid');
  if (!Number.isSafeInteger(processorCount) || processorCount < 1 || processorCount > MAX_PROCESSORS) throw new TypeError('environment settings.processorCount is invalid');
  if (!['efi', 'bios'].includes(firmware)) throw new TypeError('environment settings.firmware is invalid');
  return { memoryBytes, processorCount, firmware };
}

function normalizeEnsure(raw) {
  const value = requireObject(raw, 'environment ensure request');
  onlyKeys(value, new Set(['subject', 'profile', 'sourceIdentity', 'settings']), 'environment ensure request');
  return {
    subject: normalizeSubject(value.subject),
    profile: requireSafeId(value.profile, 'environment profile'),
    sourceIdentity: requireSafeId(value.sourceIdentity, 'environment source identity'),
    settings: normalizeSettings(value.settings ?? {}),
  };
}

function normalizeStop(raw) {
  const value = requireObject(raw, 'environment stop request');
  onlyKeys(value, new Set(['identity', 'force', 'timeoutMs']), 'environment stop request');
  const force = value.force ?? false;
  const timeoutMs = value.timeoutMs ?? 60_000;
  if (typeof force !== 'boolean') throw new TypeError('environment stop force must be boolean');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new TypeError('environment stop timeoutMs is invalid');
  return { identity: requireEnvironmentId(value.identity), force, timeoutMs };
}

function normalizeGenerationRequest(raw, kind) {
  const value = requireObject(raw, `environment ${kind} request`);
  onlyKeys(value, new Set(['identity', 'requestId', 'expectedPreviousIdentity']), `environment ${kind} request`);
  return {
    identity: requireEnvironmentId(value.identity),
    requestId: requireSafeId(value.requestId, `environment ${kind} request identity`),
    expectedPreviousIdentity: requireEnvironmentId(value.expectedPreviousIdentity, `environment ${kind} previous identity`),
  };
}

function normalizePayload(operation, raw) {
  const value = requireObject(raw ?? {}, 'lifecycle authority payload');
  if (operation === 'ensure') return normalizeEnsure(value);
  if (['list', 'reconcile', 'protected-source-identities'].includes(operation)) {
    onlyKeys(value, new Set(), 'lifecycle authority payload');
    return {};
  }
  if (['observe', 'start', 'reset', 'remove'].includes(operation)) {
    onlyKeys(value, new Set(['identity']), 'lifecycle authority payload');
    return { identity: requireEnvironmentId(value.identity) };
  }
  if (operation === 'stop') return normalizeStop(value);
  if (operation === 'reseed') {
    onlyKeys(value, new Set(['identity', 'sourceIdentity']), 'lifecycle authority payload');
    return {
      identity: requireEnvironmentId(value.identity),
      sourceIdentity: requireSafeId(value.sourceIdentity, 'environment source identity'),
    };
  }
  if (['rebuild', 'replace', 'recreate'].includes(operation)) return normalizeGenerationRequest(value, operation);
  if (operation === 'retire-superseded') {
    onlyKeys(value, new Set(['identity', 'supersededIdentity']), 'lifecycle authority payload');
    return {
      identity: requireEnvironmentId(value.identity),
      supersededIdentity: requireEnvironmentId(value.supersededIdentity, 'superseded environment identity'),
    };
  }
  throw new TypeError('lifecycle authority operation is not allowed');
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function normalizeLifecycleAuthorityRequest(raw) {
  const value = requireObject(raw, 'lifecycle authority request');
  onlyKeys(value, new Set(['protocol', 'requestId', 'operation', 'payload']), 'lifecycle authority request');
  if (value.protocol !== REQUEST_PROTOCOL) throw new TypeError('lifecycle authority request protocol is invalid');
  const requestId = requireRequestId(value.requestId);
  if (typeof value.operation !== 'string' || !OPERATIONS.has(value.operation)) throw new TypeError('lifecycle authority operation is not allowed');
  const normalized = Object.freeze({
    protocol: REQUEST_PROTOCOL,
    requestId,
    operation: value.operation,
    payload: Object.freeze(normalizePayload(value.operation, value.payload ?? {})),
  });
  if (encodedBytes(normalized) > MAX_ENVELOPE_BYTES) throw new TypeError('lifecycle authority request is too large');
  return normalized;
}

function assertJsonValue(value, name = 'lifecycle authority result') {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => assertJsonValue(entry, `${name}[${index}]`));
  if (typeof value === 'object') {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:path|location|executable|arguments|argv|command|script|providerIdentity|providerName|domainName|vmName)$/iu.test(key)) {
        throw new TypeError(`${name} contains provider authority detail`);
      }
      copy[key] = assertJsonValue(entry, `${name}.${key}`);
    }
    return copy;
  }
  throw new TypeError(`${name} contains an unsupported value`);
}

export function normalizeLifecycleAuthorityResult(raw, expectedRequestId) {
  const value = requireObject(raw, 'lifecycle authority result');
  onlyKeys(value, new Set(['protocol', 'requestId', 'ok', 'value', 'error']), 'lifecycle authority result');
  if (value.protocol !== RESULT_PROTOCOL || value.requestId !== expectedRequestId || typeof value.ok !== 'boolean') {
    throw new Error('lifecycle authority result ownership proof is invalid');
  }
  if (value.ok) {
    if (Object.hasOwn(value, 'error')) throw new TypeError('successful lifecycle authority result cannot contain error');
    const normalized = Object.freeze({ protocol: RESULT_PROTOCOL, requestId: value.requestId, ok: true, value: assertJsonValue(value.value) });
    if (encodedBytes(normalized) > MAX_ENVELOPE_BYTES) throw new TypeError('lifecycle authority result is too large');
    return normalized;
  }
  if (Object.hasOwn(value, 'value')) throw new TypeError('failed lifecycle authority result cannot contain value');
  const error = requireObject(value.error, 'lifecycle authority error');
  onlyKeys(error, new Set(['code', 'message']), 'lifecycle authority error');
  const code = requireSafeId(error.code, 'lifecycle authority error code');
  const message = typeof error.message === 'string' && error.message.length > 0 && Buffer.byteLength(error.message, 'utf8') <= 512
    ? error.message
    : 'environment lifecycle authority operation failed';
  return Object.freeze({ protocol: RESULT_PROTOCOL, requestId: value.requestId, ok: false, error: Object.freeze({ code, message }) });
}

function assertLifecycle(value) {
  const methods = ['ensure', 'list', 'observe', 'start', 'stop', 'reset', 'reseed', 'remove', 'reconcile', 'protectedSourceIdentities', 'rebuild', 'replace', 'recreate', 'retireSuperseded'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('protected lifecycle authority contract is incomplete');
  return value;
}

async function invokeLifecycle(lifecycle, request) {
  const p = request.payload;
  switch (request.operation) {
    case 'ensure': return lifecycle.ensure(p);
    case 'list': return lifecycle.list();
    case 'observe': return lifecycle.observe(p.identity);
    case 'start': return lifecycle.start(p.identity);
    case 'stop': return lifecycle.stop(p.identity, { force: p.force, timeoutMs: p.timeoutMs });
    case 'reset': return lifecycle.reset(p.identity);
    case 'reseed': return lifecycle.reseed(p.identity, { sourceIdentity: p.sourceIdentity });
    case 'remove': return lifecycle.remove(p.identity);
    case 'reconcile': return lifecycle.reconcile();
    case 'protected-source-identities': return lifecycle.protectedSourceIdentities();
    case 'rebuild': return lifecycle.rebuild(p.identity, { requestId: p.requestId, expectedPreviousIdentity: p.expectedPreviousIdentity });
    case 'replace': return lifecycle.replace(p.identity, { requestId: p.requestId, expectedPreviousIdentity: p.expectedPreviousIdentity });
    case 'recreate': return lifecycle.recreate(p.identity, { requestId: p.requestId, expectedPreviousIdentity: p.expectedPreviousIdentity });
    case 'retire-superseded': return lifecycle.retireSuperseded(p.identity, { supersededIdentity: p.supersededIdentity });
    default: throw new TypeError('lifecycle authority operation is not allowed');
  }
}

export function createLifecycleAuthorityHandler({ lifecycle }) {
  const authority = assertLifecycle(lifecycle);
  return async (raw) => {
    let request;
    try {
      request = normalizeLifecycleAuthorityRequest(raw);
    } catch {
      const requestId = typeof raw?.requestId === 'string' && /^[0-9a-f-]{36}$/iu.test(raw.requestId) ? raw.requestId : randomUUID();
      return Object.freeze({
        protocol: RESULT_PROTOCOL,
        requestId,
        ok: false,
        error: Object.freeze({ code: 'INVALID_REQUEST', message: 'lifecycle authority request was rejected' }),
      });
    }
    try {
      const result = assertJsonValue(await invokeLifecycle(authority, request));
      const response = Object.freeze({ protocol: RESULT_PROTOCOL, requestId: request.requestId, ok: true, value: result });
      if (encodedBytes(response) > MAX_ENVELOPE_BYTES) throw new TypeError('lifecycle authority result is too large');
      return response;
    } catch {
      return Object.freeze({
        protocol: RESULT_PROTOCOL,
        requestId: request.requestId,
        ok: false,
        error: Object.freeze({ code: 'OPERATION_FAILED', message: 'environment lifecycle authority operation failed' }),
      });
    }
  };
}

function assertExchange(exchange) {
  if (typeof exchange !== 'function') throw new TypeError('lifecycle authority exchange must be a function');
  return exchange;
}

export class LifecycleAuthorityClient {
  #exchange;

  constructor({ exchange }) { this.#exchange = assertExchange(exchange); }

  async #request(operation, payload = {}) {
    const request = normalizeLifecycleAuthorityRequest({ protocol: REQUEST_PROTOCOL, requestId: randomUUID(), operation, payload });
    let raw;
    try { raw = await this.#exchange(request); }
    catch { throw new Error('environment lifecycle authority is unavailable'); }
    const result = normalizeLifecycleAuthorityResult(raw, request.requestId);
    if (!result.ok) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      throw error;
    }
    return structuredClone(result.value);
  }

  ensure(input) { return this.#request('ensure', input); }
  list() { return this.#request('list'); }
  observe(identity) { return this.#request('observe', { identity }); }
  start(identity) { return this.#request('start', { identity }); }
  stop(identity, options = {}) { return this.#request('stop', { identity, ...options }); }
  reset(identity) { return this.#request('reset', { identity }); }
  reseed(identity, { sourceIdentity } = {}) { return this.#request('reseed', { identity, sourceIdentity }); }
  remove(identity) { return this.#request('remove', { identity }); }
  reconcile() { return this.#request('reconcile'); }
  protectedSourceIdentities() { return this.#request('protected-source-identities'); }
  rebuild(identity, options = {}) { return this.#request('rebuild', { identity, ...options }); }
  replace(identity, options = {}) { return this.#request('replace', { identity, ...options }); }
  recreate(identity, options = {}) { return this.#request('recreate', { identity, ...options }); }
  retireSuperseded(identity, { supersededIdentity } = {}) { return this.#request('retire-superseded', { identity, supersededIdentity }); }
}

export {
  MAX_ENVELOPE_BYTES as ENVIRONMENT_LIFECYCLE_AUTHORITY_MAX_ENVELOPE_BYTES,
  REQUEST_PROTOCOL as ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
  RESULT_PROTOCOL as ENVIRONMENT_LIFECYCLE_AUTHORITY_RESULT_PROTOCOL,
};
