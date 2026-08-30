import { randomUUID } from 'node:crypto';

const REQUEST_PROTOCOL = 'devbridge/exclusive-physical-device-authority-request-v1';
const RESULT_PROTOCOL = 'devbridge/exclusive-physical-device-authority-result-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const CLAIM_ID = /^claim-[a-f0-9]{32}$/u;
const PUBLIC_STATES = new Set([
  'AVAILABLE',
  'CLAIMING',
  'OWNED',
  'RELEASING',
  'CLAIM_FAILED',
  'RELEASE_FAILED',
  'QUARANTINED',
  'RECOVERY_REQUIRED',
]);
const READ_OPERATIONS = new Set(['observe']);
const MUTATION_OPERATIONS = new Set(['claim', 'release', 'reconcile']);
const OPERATIONS = new Set([...READ_OPERATIONS, ...MUTATION_OPERATIONS]);
const MAX_ENVELOPE_BYTES = 32 * 1024;
const MAX_REASON_BYTES = 2048;
const MAX_CAPABILITIES = 32;

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

function requireClaimId(value, name = 'physical device claim id') {
  if (typeof value !== 'string' || !CLAIM_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function requireRequestId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value)) throw new TypeError('exclusive physical device authority request identity is invalid');
  return value;
}

function optionalReason(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_REASON_BYTES) {
    throw new TypeError('exclusive physical device authority reason is invalid');
  }
  return value;
}

function normalizeEnvironment(raw, name = 'exclusive physical device environment') {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['identity', 'generation']), name);
  return Object.freeze({
    identity: requireSafeId(value.identity, `${name} identity`),
    generation: requireSafeId(value.generation, `${name} generation`),
  });
}

function normalizeTimestamp(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeClaim(raw) {
  if (raw == null) return null;
  const value = requireObject(raw, 'exclusive physical device claim');
  onlyKeys(value, new Set([
    'id',
    'subject',
    'deviceGeneration',
    'environment',
    'preparationGeneration',
    'assignmentGeneration',
    'qualificationGeneration',
    'claimedAt',
  ]), 'exclusive physical device claim');
  return Object.freeze({
    id: requireClaimId(value.id),
    subject: requireSafeId(value.subject, 'exclusive physical device claim subject'),
    deviceGeneration: requireSafeId(value.deviceGeneration, 'exclusive physical device claim generation'),
    environment: normalizeEnvironment(value.environment),
    preparationGeneration: requireSafeId(value.preparationGeneration, 'exclusive physical device preparation generation'),
    assignmentGeneration: requireSafeId(value.assignmentGeneration, 'exclusive physical device assignment generation'),
    qualificationGeneration: requireSafeId(value.qualificationGeneration, 'exclusive physical device qualification generation'),
    claimedAt: normalizeTimestamp(value.claimedAt, 'exclusive physical device claim timestamp'),
  });
}

function normalizePayload(operation, raw) {
  const value = requireObject(raw ?? {}, 'exclusive physical device authority payload');
  if (operation === 'observe' || operation === 'reconcile') {
    onlyKeys(value, new Set(['subject']), 'exclusive physical device authority payload');
    return Object.freeze({ subject: requireSafeId(value.subject, 'physical device subject') });
  }
  if (operation === 'claim') {
    onlyKeys(value, new Set(['subject', 'environment']), 'exclusive physical device authority payload');
    return Object.freeze({
      subject: requireSafeId(value.subject, 'physical device subject'),
      environment: normalizeEnvironment(value.environment),
    });
  }
  if (operation === 'release') {
    onlyKeys(value, new Set(['claim']), 'exclusive physical device authority payload');
    const claim = normalizeClaim(value.claim);
    if (claim == null) throw new TypeError('exclusive physical device release claim is required');
    return Object.freeze({ claim });
  }
  throw new TypeError('exclusive physical device authority operation is not allowed');
}

function encodedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function normalizeExclusivePhysicalDeviceAuthorityRequest(raw) {
  const value = requireObject(raw, 'exclusive physical device authority request');
  onlyKeys(value, new Set(['protocol', 'requestId', 'operation', 'payload']), 'exclusive physical device authority request');
  if (value.protocol !== REQUEST_PROTOCOL) throw new TypeError('exclusive physical device authority request protocol is invalid');
  const requestId = requireRequestId(value.requestId);
  if (typeof value.operation !== 'string' || !OPERATIONS.has(value.operation)) throw new TypeError('exclusive physical device authority operation is not allowed');
  const normalized = Object.freeze({
    protocol: REQUEST_PROTOCOL,
    requestId,
    operation: value.operation,
    payload: normalizePayload(value.operation, value.payload),
  });
  if (encodedBytes(normalized) > MAX_ENVELOPE_BYTES) throw new TypeError('exclusive physical device authority request is too large');
  return normalized;
}

function normalizeProvider(raw) {
  const value = requireObject(raw, 'exclusive physical device provider observation');
  onlyKeys(value, new Set(['state', 'rootSafe', 'owner', 'assignmentGeneration', 'reason']), 'exclusive physical device provider observation');
  if (!['available', 'owned', 'unknown'].includes(value.state)) throw new TypeError('exclusive physical device provider state is invalid');
  if (typeof value.rootSafe !== 'boolean') throw new TypeError('exclusive physical device provider root-safe state is invalid');
  const owner = value.owner == null ? null : normalizeEnvironment(value.owner, 'exclusive physical device provider owner');
  const assignmentGeneration = value.assignmentGeneration == null
    ? null
    : requireSafeId(value.assignmentGeneration, 'exclusive physical device provider assignment generation');
  if (value.state === 'available' && (!value.rootSafe || owner != null)) throw new Error('available physical device provider observation is not root-safe');
  if (value.state === 'owned' && (value.rootSafe || owner == null || assignmentGeneration == null)) throw new Error('owned physical device provider observation is incomplete');
  if (value.state === 'unknown' && value.rootSafe) throw new Error('unknown physical device provider observation cannot be root-safe');
  return Object.freeze({
    state: value.state,
    rootSafe: value.rootSafe,
    owner,
    assignmentGeneration,
    reason: optionalReason(value.reason),
  });
}

function normalizeCapabilities(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_CAPABILITIES) throw new TypeError('exclusive physical device capabilities are invalid');
  return Object.freeze([...new Set(raw.map((item) => requireSafeId(item, 'exclusive physical device capability')))]);
}

function expectedSubject(request) {
  if (request.operation === 'release') return request.payload.claim.subject;
  return request.payload.subject;
}

function normalizeStatus(raw, request) {
  const value = requireObject(raw, 'exclusive physical device authority status');
  onlyKeys(value, new Set([
    'subject',
    'deviceGeneration',
    'state',
    'capabilities',
    'claim',
    'provider',
    'reason',
    'releasedClaimId',
    'formerOwnerPreparationReady',
    'formerOwnerPreparationGeneration',
  ]), 'exclusive physical device authority status');
  const subject = requireSafeId(value.subject, 'exclusive physical device status subject');
  if (subject !== expectedSubject(request)) throw new Error('exclusive physical device authority result subject changed');
  if (!PUBLIC_STATES.has(value.state)) throw new TypeError('exclusive physical device authority state is invalid');
  const claim = normalizeClaim(value.claim);
  if (claim != null && claim.subject !== subject) throw new Error('exclusive physical device authority claim subject changed');
  const status = {
    subject,
    deviceGeneration: requireSafeId(value.deviceGeneration, 'exclusive physical device status generation'),
    state: value.state,
    capabilities: normalizeCapabilities(value.capabilities),
    claim,
    provider: normalizeProvider(value.provider),
    reason: optionalReason(value.reason),
  };
  if (Object.hasOwn(value, 'releasedClaimId')) status.releasedClaimId = requireClaimId(value.releasedClaimId, 'released physical device claim id');
  if (Object.hasOwn(value, 'formerOwnerPreparationReady')) {
    if (typeof value.formerOwnerPreparationReady !== 'boolean') throw new TypeError('former owner preparation readiness is invalid');
    status.formerOwnerPreparationReady = value.formerOwnerPreparationReady;
  }
  if (Object.hasOwn(value, 'formerOwnerPreparationGeneration')) {
    status.formerOwnerPreparationGeneration = requireSafeId(value.formerOwnerPreparationGeneration, 'former owner preparation generation');
  }
  return Object.freeze(status);
}

export function normalizeExclusivePhysicalDeviceAuthorityResult(raw, expectedRequest) {
  const request = normalizeExclusivePhysicalDeviceAuthorityRequest(expectedRequest);
  const value = requireObject(raw, 'exclusive physical device authority result');
  onlyKeys(value, new Set(['protocol', 'requestId', 'ok', 'value', 'error']), 'exclusive physical device authority result');
  if (value.protocol !== RESULT_PROTOCOL || value.requestId !== request.requestId || typeof value.ok !== 'boolean') {
    throw new Error('exclusive physical device authority result ownership proof is invalid');
  }
  if (value.ok) {
    if (Object.hasOwn(value, 'error')) throw new TypeError('successful exclusive physical device authority result cannot contain error');
    const normalized = Object.freeze({
      protocol: RESULT_PROTOCOL,
      requestId: request.requestId,
      ok: true,
      value: normalizeStatus(value.value, request),
    });
    if (encodedBytes(normalized) > MAX_ENVELOPE_BYTES) throw new TypeError('exclusive physical device authority result is too large');
    return normalized;
  }
  if (Object.hasOwn(value, 'value')) throw new TypeError('failed exclusive physical device authority result cannot contain value');
  const error = requireObject(value.error, 'exclusive physical device authority error');
  onlyKeys(error, new Set(['code', 'message']), 'exclusive physical device authority error');
  const code = requireSafeId(error.code, 'exclusive physical device authority error code');
  const message = typeof error.message === 'string' && error.message.length > 0 && !error.message.includes('\0') && Buffer.byteLength(error.message, 'utf8') <= MAX_REASON_BYTES
    ? error.message
    : 'exclusive physical device authority operation failed';
  return Object.freeze({ protocol: RESULT_PROTOCOL, requestId: request.requestId, ok: false, error: Object.freeze({ code, message }) });
}

function assertAuthority(value) {
  if (!value || ['observe', 'claim', 'release', 'reconcile'].some((method) => typeof value[method] !== 'function')) {
    throw new TypeError('exclusive physical device semantic authority contract is incomplete');
  }
  return value;
}

async function invokeAuthority(authority, request) {
  if (request.operation === 'observe') return authority.observe(request.payload.subject);
  if (request.operation === 'claim') return authority.claim(request.payload.subject, request.payload.environment);
  if (request.operation === 'release') return authority.release(request.payload.claim);
  if (request.operation === 'reconcile') return authority.reconcile(request.payload.subject);
  throw new TypeError('exclusive physical device authority operation is not allowed');
}

function createAuthorityHandler({ authority, allowedOperations }) {
  const owner = assertAuthority(authority);
  const allowed = new Set(allowedOperations);
  return async (raw) => {
    let request;
    try {
      request = normalizeExclusivePhysicalDeviceAuthorityRequest(raw);
    } catch {
      const requestId = typeof raw?.requestId === 'string' && /^[0-9a-f-]{36}$/iu.test(raw.requestId) ? raw.requestId : randomUUID();
      return Object.freeze({
        protocol: RESULT_PROTOCOL,
        requestId,
        ok: false,
        error: Object.freeze({ code: 'INVALID_REQUEST', message: 'exclusive physical device authority request was rejected' }),
      });
    }
    if (!allowed.has(request.operation)) {
      return Object.freeze({
        protocol: RESULT_PROTOCOL,
        requestId: request.requestId,
        ok: false,
        error: Object.freeze({ code: 'OPERATION_NOT_ALLOWED', message: 'exclusive physical device authority operation is not available on this endpoint' }),
      });
    }
    try {
      const status = normalizeStatus(await invokeAuthority(owner, request), request);
      const response = Object.freeze({ protocol: RESULT_PROTOCOL, requestId: request.requestId, ok: true, value: status });
      if (encodedBytes(response) > MAX_ENVELOPE_BYTES) throw new TypeError('exclusive physical device authority result is too large');
      return response;
    } catch {
      return Object.freeze({
        protocol: RESULT_PROTOCOL,
        requestId: request.requestId,
        ok: false,
        error: Object.freeze({ code: 'OPERATION_FAILED', message: 'exclusive physical device authority operation failed' }),
      });
    }
  };
}

export function createExclusivePhysicalDeviceAuthorityReadHandler({ authority }) {
  return createAuthorityHandler({ authority, allowedOperations: READ_OPERATIONS });
}

export function createExclusivePhysicalDeviceAuthorityMutationHandler({ authority }) {
  return createAuthorityHandler({ authority, allowedOperations: MUTATION_OPERATIONS });
}

function assertExchange(exchange, name) {
  if (typeof exchange !== 'function') throw new TypeError(`${name} must be a function`);
  return exchange;
}

export class ExclusivePhysicalDeviceAuthorityClient {
  #readExchange;
  #mutationExchange;

  constructor({ readExchange, mutationExchange } = {}) {
    this.#readExchange = assertExchange(readExchange, 'exclusive physical device authority read exchange');
    this.#mutationExchange = assertExchange(mutationExchange, 'exclusive physical device authority mutation exchange');
  }

  async #request(operation, payload) {
    const request = normalizeExclusivePhysicalDeviceAuthorityRequest({
      protocol: REQUEST_PROTOCOL,
      requestId: randomUUID(),
      operation,
      payload,
    });
    const exchange = MUTATION_OPERATIONS.has(operation) ? this.#mutationExchange : this.#readExchange;
    let raw;
    try { raw = await exchange(request); }
    catch { throw new Error('exclusive physical device authority is unavailable'); }
    const result = normalizeExclusivePhysicalDeviceAuthorityResult(raw, request);
    if (!result.ok) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      throw error;
    }
    return structuredClone(result.value);
  }

  observe(subject) { return this.#request('observe', { subject }); }
  claim(subject, environment) { return this.#request('claim', { subject, environment }); }
  release(claim) { return this.#request('release', { claim }); }
  reconcile(subject) { return this.#request('reconcile', { subject }); }
}

export {
  MAX_ENVELOPE_BYTES as EXCLUSIVE_PHYSICAL_DEVICE_AUTHORITY_MAX_ENVELOPE_BYTES,
  REQUEST_PROTOCOL as EXCLUSIVE_PHYSICAL_DEVICE_AUTHORITY_REQUEST_PROTOCOL,
  RESULT_PROTOCOL as EXCLUSIVE_PHYSICAL_DEVICE_AUTHORITY_RESULT_PROTOCOL,
};
