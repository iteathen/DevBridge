import { randomUUID } from 'node:crypto';

const REQUEST_PROTOCOL = 'devbridge/environment-configuration-authority-request-v1';
const RESULT_PROTOCOL = 'devbridge/environment-configuration-authority-result-v1';
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SUBJECT = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Z][A-Z0-9_]{0,63}$/u;
const OPERATIONS = new Set(['inspect', 'reconcile']);
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function exact(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function bounded(value, name, maximum) {
  let text;
  try { text = JSON.stringify(value); } catch { throw new TypeError(`${name} is not serializable`); }
  if (typeof text !== 'string') throw new TypeError(`${name} is not serializable`);
  if (Buffer.byteLength(text, 'utf8') > maximum) throw new TypeError(`${name} is too large`);
  return text;
}

function revision(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`);
  return value;
}

function subject(value, name) {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function reconcilePayload(raw) {
  const value = exact(object(raw, 'environment configuration payload'), new Set(['revision', 'subject']), 'environment configuration payload');
  return Object.freeze({
    revision: revision(value.revision, 'environment configuration payload.revision'),
    subject: subject(value.subject, 'environment configuration payload.subject'),
  });
}

function payload(operation, raw) {
  if (operation === 'inspect') {
    exact(object(raw, 'environment configuration payload'), new Set(), 'environment configuration payload');
    return Object.freeze({});
  }
  return reconcilePayload(raw);
}

export function normalizeEnvironmentConfigurationRequest(raw) {
  const value = exact(object(raw, 'environment configuration request'), new Set(['protocol', 'requestId', 'operation', 'payload']), 'environment configuration request');
  if (value.protocol !== REQUEST_PROTOCOL) throw new TypeError('environment configuration request protocol is unsupported');
  if (typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) throw new TypeError('environment configuration request identity is invalid');
  if (typeof value.operation !== 'string' || !OPERATIONS.has(value.operation)) throw new TypeError('environment configuration operation is invalid');
  const result = Object.freeze({
    protocol: REQUEST_PROTOCOL,
    requestId: value.requestId,
    operation: value.operation,
    payload: payload(value.operation, value.payload),
  });
  bounded(result, 'environment configuration request', MAX_REQUEST_BYTES);
  return result;
}

function projected(raw, expected) {
  const value = exact(object(raw, 'environment configuration evidence'), new Set(['ready', 'changed', 'revision', 'subject']), 'environment configuration evidence');
  if (expected.operation === 'inspect') {
    if (value.ready !== true || Object.keys(value).length !== 1) throw new TypeError('environment configuration inspection evidence is invalid');
    return Object.freeze({ ready: true });
  }
  if (value.ready !== true || typeof value.changed !== 'boolean') throw new TypeError('environment configuration evidence is invalid');
  const selectedRevision = revision(value.revision, 'environment configuration evidence.revision');
  const selectedSubject = subject(value.subject, 'environment configuration evidence.subject');
  if (selectedRevision !== expected.payload.revision || selectedSubject !== expected.payload.subject) {
    throw new Error('environment configuration evidence subject changed');
  }
  return Object.freeze({ ready: true, changed: value.changed, revision: selectedRevision, subject: selectedSubject });
}

export function normalizeEnvironmentConfigurationResult(raw, expectedRaw) {
  const expected = normalizeEnvironmentConfigurationRequest(expectedRaw);
  bounded(raw, 'environment configuration result', MAX_RESULT_BYTES);
  const value = exact(object(raw, 'environment configuration result'), new Set(['protocol', 'requestId', 'ok', 'value', 'error']), 'environment configuration result');
  if (value.protocol !== RESULT_PROTOCOL || value.requestId !== expected.requestId || typeof value.ok !== 'boolean') {
    throw new Error('environment configuration result ownership proof is invalid');
  }
  if (value.ok) {
    if (Object.hasOwn(value, 'error')) throw new TypeError('successful environment configuration result cannot contain error');
    return Object.freeze({ protocol: RESULT_PROTOCOL, requestId: expected.requestId, ok: true, value: projected(value.value, expected) });
  }
  if (Object.hasOwn(value, 'value')) throw new TypeError('failed environment configuration result cannot contain value');
  const error = exact(object(value.error, 'environment configuration error'), new Set(['code', 'message']), 'environment configuration error');
  const code = typeof error.code === 'string' && SAFE_ID.test(error.code) ? error.code : 'OPERATION_FAILED';
  const message = typeof error.message === 'string' && error.message.length > 0 && Buffer.byteLength(error.message, 'utf8') <= 512
    ? error.message
    : 'environment configuration operation failed';
  return Object.freeze({ protocol: RESULT_PROTOCOL, requestId: expected.requestId, ok: false, error: Object.freeze({ code, message }) });
}

function port(value) {
  if (!value || typeof value.inspect !== 'function' || typeof value.reconcile !== 'function') throw new TypeError('environment configuration port is incomplete');
  return value;
}

export function createEnvironmentConfigurationHandler({ configuration } = {}) {
  const selected = port(configuration);
  return async (raw) => {
    let request;
    try { request = normalizeEnvironmentConfigurationRequest(raw); }
    catch {
      const requestId = typeof raw?.requestId === 'string' && REQUEST_ID.test(raw.requestId) ? raw.requestId : randomUUID();
      return Object.freeze({
        protocol: RESULT_PROTOCOL,
        requestId,
        ok: false,
        error: Object.freeze({ code: 'INVALID_REQUEST', message: 'environment configuration request was rejected' }),
      });
    }
    try {
      const evidence = projected(await (request.operation === 'inspect' ? selected.inspect() : selected.reconcile(request.payload)), request);
      const response = Object.freeze({ protocol: RESULT_PROTOCOL, requestId: request.requestId, ok: true, value: evidence });
      bounded(response, 'environment configuration result', MAX_RESULT_BYTES);
      return response;
    } catch {
      return Object.freeze({
        protocol: RESULT_PROTOCOL,
        requestId: request.requestId,
        ok: false,
        error: Object.freeze({ code: 'OPERATION_FAILED', message: 'environment configuration operation failed' }),
      });
    }
  };
}

function exchange(value) {
  if (typeof value !== 'function') throw new TypeError('environment configuration exchange must be a function');
  return value;
}

export class EnvironmentConfigurationClient {
  #exchange;

  constructor({ exchange: selected } = {}) {
    this.#exchange = exchange(selected);
  }

  async #request(operation, raw) {
    const selected = payload(operation, raw);
    const request = normalizeEnvironmentConfigurationRequest({
      protocol: REQUEST_PROTOCOL,
      requestId: randomUUID(),
      operation,
      payload: selected,
    });
    let rawResult;
    try { rawResult = await this.#exchange(request); }
    catch {
      const error = new Error('environment configuration authority is unavailable');
      error.code = 'ENVIRONMENT_CONFIGURATION_AUTHORITY_UNAVAILABLE';
      throw error;
    }
    const result = normalizeEnvironmentConfigurationResult(rawResult, request);
    if (!result.ok) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      throw error;
    }
    return structuredClone(result.value);
  }

  inspect() { return this.#request('inspect', {}); }
  reconcile(raw) { return this.#request('reconcile', raw); }
}

export {
  MAX_REQUEST_BYTES as ENVIRONMENT_CONFIGURATION_AUTHORITY_MAX_REQUEST_BYTES,
  MAX_RESULT_BYTES as ENVIRONMENT_CONFIGURATION_AUTHORITY_MAX_RESULT_BYTES,
  REQUEST_PROTOCOL as ENVIRONMENT_CONFIGURATION_AUTHORITY_REQUEST_PROTOCOL,
  RESULT_PROTOCOL as ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL,
};
