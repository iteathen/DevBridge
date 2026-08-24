import { randomUUID } from 'node:crypto';

const REQUEST_PROTOCOL = 'devbridge/environment-lifecycle-authority-request-v1';
const RESULT_PROTOCOL = 'devbridge/environment-lifecycle-authority-result-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const MAX_SUBJECT_BYTES = 512;
const MAX_ENVELOPE_BYTES = 16 * 1024;
const AUTHORITY_OPERATIONS = new Set(['inspect', 'list', 'status', 'plan', 'run', 'resume']);
const LIFECYCLE_OPERATIONS = new Set(['create', 'repair', 'rebuild', 'reset', 'recreate']);
const FORBIDDEN_RESULT_KEYS = new Set([
  'path', 'location', 'executable', 'arguments', 'argv', 'command', 'script',
  'provider', 'providerIdentity', 'providerName', 'domainName', 'vmName', 'diskName',
  'xml', 'rawXml', 'socket', 'endpoint', 'credential', 'token',
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

function requireRequestId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value)) throw new TypeError('authority request identity is invalid');
  return value;
}

function optionalApproval(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_SUBJECT_BYTES) {
    throw new TypeError('environment lifecycle approval is invalid');
  }
  return value;
}

function requireLifecycleOperation(value) {
  if (typeof value !== 'string' || !LIFECYCLE_OPERATIONS.has(value)) throw new TypeError('environment lifecycle operation is invalid');
  return value;
}

function normalizePayload(operation, raw) {
  const value = requireObject(raw ?? {}, 'lifecycle authority payload');
  if (operation === 'inspect' || operation === 'list') {
    onlyKeys(value, new Set(), 'lifecycle authority payload');
    return {};
  }
  if (operation === 'status') {
    onlyKeys(value, new Set(['identity']), 'lifecycle authority payload');
    return { identity: requireSafeId(value.identity, 'environment identity') };
  }
  if (operation === 'plan') {
    onlyKeys(value, new Set(['operation', 'identity']), 'lifecycle authority payload');
    return { operation: requireLifecycleOperation(value.operation), identity: requireSafeId(value.identity, 'environment identity') };
  }
  if (operation === 'run') {
    onlyKeys(value, new Set(['operation', 'identity', 'approval']), 'lifecycle authority payload');
    return {
      operation: requireLifecycleOperation(value.operation),
      identity: requireSafeId(value.identity, 'environment identity'),
      approval: optionalApproval(value.approval),
    };
  }
  if (operation === 'resume') {
    onlyKeys(value, new Set(['identity', 'approval']), 'lifecycle authority payload');
    return { identity: requireSafeId(value.identity, 'environment identity'), approval: optionalApproval(value.approval) };
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
  if (typeof value.operation !== 'string' || !AUTHORITY_OPERATIONS.has(value.operation)) throw new TypeError('lifecycle authority operation is not allowed');
  const normalized = Object.freeze({
    protocol: REQUEST_PROTOCOL,
    requestId,
    operation: value.operation,
    payload: Object.freeze(normalizePayload(value.operation, value.payload ?? {})),
  });
  if (encodedBytes(normalized) > MAX_ENVELOPE_BYTES) throw new TypeError('lifecycle authority request is too large');
  return normalized;
}

function looksLikeHostAuthorityString(value) {
  return /^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\/u.test(value)
    || /^\/(?:var|etc|run|usr|opt|home|root|mnt|srv|dev|proc|sys)\//u.test(value)
    || /\b(?:powershell(?:\.exe)?|virsh|Remove-VM|Remove-VMSwitch|rm\s+-rf)\b/iu.test(value);
}

function assertJsonValue(value, name = 'lifecycle authority result') {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (looksLikeHostAuthorityString(value)) throw new TypeError(`${name} contains provider authority detail`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => assertJsonValue(entry, `${name}[${index}]`));
  if (typeof value === 'object') {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_RESULT_KEYS.has(key)) throw new TypeError(`${name} contains provider authority detail`);
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

function assertOperator(value) {
  const methods = ['inspect', 'list', 'status', 'plan', 'run', 'resume'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('protected environment operator contract is incomplete');
  return value;
}

async function invokeOperator(operator, request) {
  const p = request.payload;
  switch (request.operation) {
    case 'inspect': return operator.inspect();
    case 'list': return operator.list();
    case 'status': return operator.status(p.identity);
    case 'plan': return operator.plan(p.operation, p.identity);
    case 'run': return operator.run(p.operation, p.identity, { approval: p.approval });
    case 'resume': return operator.resume(p.identity, { approval: p.approval });
    default: throw new TypeError('lifecycle authority operation is not allowed');
  }
}

export function createLifecycleAuthorityHandler({ operator }) {
  const authority = assertOperator(operator);
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
      const result = assertJsonValue(await invokeOperator(authority, request));
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

  inspect() { return this.#request('inspect'); }
  list() { return this.#request('list'); }
  status(identity) { return this.#request('status', { identity }); }
  plan(operation, identity) { return this.#request('plan', { operation, identity }); }
  run(operation, identity, { approval = null } = {}) { return this.#request('run', { operation, identity, approval }); }
  resume(identity, { approval = null } = {}) { return this.#request('resume', { identity, approval }); }
}

export {
  MAX_ENVELOPE_BYTES as ENVIRONMENT_LIFECYCLE_AUTHORITY_MAX_ENVELOPE_BYTES,
  REQUEST_PROTOCOL as ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
  RESULT_PROTOCOL as ENVIRONMENT_LIFECYCLE_AUTHORITY_RESULT_PROTOCOL,
};
