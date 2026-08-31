import { randomUUID } from 'node:crypto';
import {
  normalizeEnvironmentBridgeRequest,
  normalizeEnvironmentBridgeResponse,
} from './environment-bridge.js';

const REQUEST_PROTOCOL = 'devbridge/environment-activity-authority-request-v1';
const RESULT_PROTOCOL = 'devbridge/environment-activity-authority-result-v1';
const OPERATIONS = new Set(['inspect', 'list', 'observe', 'prepare', 'exchange']);
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_ENVIRONMENTS = 256;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function encodedBytes(value, name, limit) {
  let text;
  try { text = JSON.stringify(value); } catch { throw new TypeError(`${name} is not serializable`); }
  if (Buffer.byteLength(text, 'utf8') > limit) throw new TypeError(`${name} is too large`);
  return text;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function target(value) {
  if (typeof value !== 'string' || !TARGET.test(value)) throw new TypeError('environment activity target is invalid');
  return value;
}

function emptyPayload(raw, name) {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(), name);
  return {};
}

function normalizePayload(operation, raw) {
  if (operation === 'inspect' || operation === 'list') return emptyPayload(raw, `environment activity ${operation} payload`);
  const value = requireObject(raw, `environment activity ${operation} payload`);
  if (operation === 'observe' || operation === 'prepare') {
    onlyKeys(value, new Set(['target']), `environment activity ${operation} payload`);
    return { target: target(value.target) };
  }
  if (operation === 'exchange') {
    onlyKeys(value, new Set(['frame']), 'environment activity exchange payload');
    return { frame: normalizeEnvironmentBridgeRequest(value.frame) };
  }
  throw new TypeError('environment activity operation is invalid');
}

export function normalizeEnvironmentActivityRequest(raw) {
  const value = requireObject(raw, 'environment activity request');
  onlyKeys(value, new Set(['protocol', 'requestId', 'operation', 'payload']), 'environment activity request');
  if (value.protocol !== REQUEST_PROTOCOL) throw new TypeError('environment activity request protocol is unsupported');
  if (typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) throw new TypeError('environment activity request identity is invalid');
  if (typeof value.operation !== 'string' || !OPERATIONS.has(value.operation)) throw new TypeError('environment activity operation is invalid');
  const result = {
    protocol: REQUEST_PROTOCOL,
    requestId: value.requestId,
    operation: value.operation,
    payload: normalizePayload(value.operation, value.payload),
  };
  encodedBytes(result, 'environment activity request', MAX_REQUEST_BYTES);
  return Object.freeze(result);
}

function projectStatus(raw) {
  const value = requireObject(raw, 'environment activity status');
  if (typeof value.ready !== 'boolean') throw new TypeError('environment activity status.ready must be boolean');
  const identity = value.identity == null ? null : safeId(value.identity, 'environment activity status.identity');
  return Object.freeze({
    ready: value.ready,
    identity,
    reason: value.ready ? null : 'environment activity is unavailable',
  });
}

function projectEnvironment(raw) {
  const value = requireObject(raw, 'environment activity environment');
  const record = requireObject(value.record, 'environment activity environment.record');
  const observation = requireObject(value.observation, 'environment activity environment.observation');
  const identity = target(record.identity);
  if (typeof record.subject !== 'string' || !/^\d+$/u.test(record.subject)) throw new TypeError('environment activity environment.record.subject is invalid');
  const profile = safeId(record.profile, 'environment activity environment.record.profile');
  if (observation.identity !== identity) throw new TypeError('environment activity observation identity is invalid');
  for (const name of ['exists', 'owned', 'compatible']) {
    if (typeof observation[name] !== 'boolean') throw new TypeError(`environment activity observation.${name} must be boolean`);
  }
  const state = observation.state == null ? null : safeId(observation.state, 'environment activity observation.state');
  const ready = observation.exists && observation.owned && observation.compatible;
  return Object.freeze({
    record: Object.freeze({ identity, subject: record.subject, profile }),
    observation: Object.freeze({
      identity,
      exists: observation.exists,
      owned: observation.owned,
      compatible: observation.compatible,
      state,
      reason: ready ? null : 'environment activity target is unavailable',
    }),
  });
}

function projectList(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_ENVIRONMENTS) throw new TypeError('environment activity environment list is invalid');
  return Object.freeze(raw.map(projectEnvironment));
}

function projectPreparation(raw) {
  const value = requireObject(raw, 'environment activity preparation');
  return Object.freeze({ generation: safeId(value.generation, 'environment activity preparation.generation') });
}

function projectValue(operation, raw, request) {
  if (operation === 'inspect') return projectStatus(raw);
  if (operation === 'list') return projectList(raw);
  if (operation === 'observe') return projectEnvironment(raw);
  if (operation === 'prepare') return projectPreparation(raw);
  if (operation === 'exchange') {
    const candidate = raw?.frame ?? raw;
    return Object.freeze({ frame: normalizeEnvironmentBridgeResponse(candidate, request.payload.frame) });
  }
  throw new TypeError('environment activity operation is invalid');
}

export function normalizeEnvironmentActivityResult(raw, expectedRaw) {
  const expected = normalizeEnvironmentActivityRequest(expectedRaw);
  encodedBytes(raw, 'environment activity result', MAX_RESULT_BYTES);
  const value = requireObject(raw, 'environment activity result');
  onlyKeys(value, new Set(['protocol', 'requestId', 'ok', 'value', 'error']), 'environment activity result');
  if (value.protocol !== RESULT_PROTOCOL || value.requestId !== expected.requestId || typeof value.ok !== 'boolean') {
    throw new Error('environment activity result ownership proof is invalid');
  }
  if (value.ok) {
    if (Object.hasOwn(value, 'error')) throw new TypeError('successful environment activity result cannot contain error');
    return Object.freeze({
      protocol: RESULT_PROTOCOL,
      requestId: expected.requestId,
      ok: true,
      value: projectValue(expected.operation, value.value, expected),
    });
  }
  if (Object.hasOwn(value, 'value')) throw new TypeError('failed environment activity result cannot contain value');
  const error = requireObject(value.error, 'environment activity error');
  onlyKeys(error, new Set(['code', 'message']), 'environment activity error');
  const code = safeId(error.code, 'environment activity error.code');
  const message = typeof error.message === 'string' && error.message.length > 0 && Buffer.byteLength(error.message, 'utf8') <= 512
    ? error.message
    : 'environment activity operation failed';
  return Object.freeze({ protocol: RESULT_PROTOCOL, requestId: expected.requestId, ok: false, error: Object.freeze({ code, message }) });
}

function assertActivity(value) {
  const methods = ['inspect', 'list', 'observe', 'prepare', 'exchange'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('protected environment activity contract is incomplete');
  return value;
}

async function invokeActivity(activity, request, options) {
  if (request.operation === 'inspect') return activity.inspect(options);
  if (request.operation === 'list') return activity.list(options);
  if (request.operation === 'observe') return activity.observe(request.payload.target, options);
  if (request.operation === 'prepare') return activity.prepare(request.payload.target, options);
  if (request.operation === 'exchange') return activity.exchange(request.payload.frame, options);
  throw new TypeError('environment activity operation is invalid');
}

export function createEnvironmentActivityHandler({ activity } = {}) {
  const selected = assertActivity(activity);
  return async (raw, { signal = null } = {}) => {
    let request;
    try { request = normalizeEnvironmentActivityRequest(raw); }
    catch {
      const requestId = typeof raw?.requestId === 'string' && REQUEST_ID.test(raw.requestId) ? raw.requestId : randomUUID();
      return Object.freeze({
        protocol: RESULT_PROTOCOL,
        requestId,
        ok: false,
        error: Object.freeze({ code: 'INVALID_REQUEST', message: 'environment activity request was rejected' }),
      });
    }
    try {
      const projected = projectValue(request.operation, await invokeActivity(selected, request, { signal }), request);
      const response = Object.freeze({ protocol: RESULT_PROTOCOL, requestId: request.requestId, ok: true, value: projected });
      encodedBytes(response, 'environment activity result', MAX_RESULT_BYTES);
      return response;
    } catch {
      return Object.freeze({
        protocol: RESULT_PROTOCOL,
        requestId: request.requestId,
        ok: false,
        error: Object.freeze({ code: 'OPERATION_FAILED', message: 'environment activity operation failed' }),
      });
    }
  };
}

function assertExchange(exchange) {
  if (typeof exchange !== 'function') throw new TypeError('environment activity exchange must be a function');
  return exchange;
}

export class EnvironmentActivityClient {
  #exchange;

  constructor({ exchange } = {}) {
    this.#exchange = assertExchange(exchange);
  }

  async #request(operation, payload = {}, { signal = null } = {}) {
    const request = normalizeEnvironmentActivityRequest({ protocol: REQUEST_PROTOCOL, requestId: randomUUID(), operation, payload });
    let raw;
    try { raw = await this.#exchange(request, { signal }); }
    catch { throw new Error('environment activity authority is unavailable'); }
    const result = normalizeEnvironmentActivityResult(raw, request);
    if (!result.ok) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      throw error;
    }
    return structuredClone(result.value);
  }

  inspect(options = {}) { return this.#request('inspect', {}, options); }
  list(options = {}) { return this.#request('list', {}, options); }
  observe(targetValue, options = {}) { return this.#request('observe', { target: targetValue }, options); }
  prepare(targetValue, options = {}) { return this.#request('prepare', { target: targetValue }, options); }
  async exchange(frame, { signal = null } = {}) {
    const value = await this.#request('exchange', { frame }, { signal });
    return value.frame;
  }
}

export {
  MAX_REQUEST_BYTES as ENVIRONMENT_ACTIVITY_AUTHORITY_MAX_REQUEST_BYTES,
  MAX_RESULT_BYTES as ENVIRONMENT_ACTIVITY_AUTHORITY_MAX_RESULT_BYTES,
  REQUEST_PROTOCOL as ENVIRONMENT_ACTIVITY_AUTHORITY_REQUEST_PROTOCOL,
  RESULT_PROTOCOL as ENVIRONMENT_ACTIVITY_AUTHORITY_RESULT_PROTOCOL,
};
