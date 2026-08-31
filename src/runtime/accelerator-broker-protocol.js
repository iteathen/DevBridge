import { createHash } from 'node:crypto';
import { COMPUTE_TOPOLOGY } from './compute-capabilities.js';

export const ACCELERATOR_BROKER_EXECUTE_PROTOCOL = 'devbridge/accelerator-broker-execute-v1';
export const ACCELERATOR_BROKER_CANCEL_PROTOCOL = 'devbridge/accelerator-broker-cancel-v1';
export const ACCELERATOR_BROKER_OBSERVATION_PROTOCOL = 'devbridge/accelerator-broker-observation-v1';
export const ACCELERATOR_BROKER_BINDING_MATCH_PROTOCOL = 'devbridge/accelerator-broker-binding-match-v1';

export const ACCELERATOR_BROKER_OPERATION = Object.freeze({
  CUDA_CANARY_U32_ADD_V1: 'cuda.canary.u32-add-v1',
});

export const ACCELERATOR_BROKER_STATE = Object.freeze({
  REJECTED: 'rejected',
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

export const ACCELERATOR_BROKER_LIMITS = Object.freeze({
  maxCanaryVectorLength: 4096,
});

export const ACCELERATOR_BROKER_REASON = Object.freeze({
  BINDING_STALE: 'binding-stale',
  BACKEND_UNAVAILABLE: 'backend-unavailable',
  OPERATION_UNAVAILABLE: 'operation-unavailable',
  REQUEST_CONFLICT: 'request-conflict',
  EXECUTION_FAILED: 'execution-failed',
  EXECUTION_TIMEOUT: 'execution-timeout',
  BACKEND_LOST: 'backend-lost',
  EXECUTION_CANCELLED: 'execution-cancelled',
  STATE_UNKNOWN: 'state-unknown',
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const DIGEST = /^sha256-[0-9a-f]{64}$/u;
const MAX_CANARY_VECTOR_LENGTH = ACCELERATOR_BROKER_LIMITS.maxCanaryVectorLength;
const UINT32_MAX = 0xffff_ffff;
const TERMINAL_STATES = new Set([
  ACCELERATOR_BROKER_STATE.REJECTED,
  ACCELERATOR_BROKER_STATE.SUCCEEDED,
  ACCELERATOR_BROKER_STATE.FAILED,
  ACCELERATOR_BROKER_STATE.CANCELLED,
]);
const REASON_RULES = Object.freeze({
  [ACCELERATOR_BROKER_REASON.BINDING_STALE]: ACCELERATOR_BROKER_STATE.REJECTED,
  [ACCELERATOR_BROKER_REASON.BACKEND_UNAVAILABLE]: ACCELERATOR_BROKER_STATE.REJECTED,
  [ACCELERATOR_BROKER_REASON.OPERATION_UNAVAILABLE]: ACCELERATOR_BROKER_STATE.REJECTED,
  [ACCELERATOR_BROKER_REASON.REQUEST_CONFLICT]: ACCELERATOR_BROKER_STATE.REJECTED,
  [ACCELERATOR_BROKER_REASON.EXECUTION_FAILED]: ACCELERATOR_BROKER_STATE.FAILED,
  [ACCELERATOR_BROKER_REASON.EXECUTION_TIMEOUT]: ACCELERATOR_BROKER_STATE.FAILED,
  [ACCELERATOR_BROKER_REASON.BACKEND_LOST]: ACCELERATOR_BROKER_STATE.FAILED,
  [ACCELERATOR_BROKER_REASON.EXECUTION_CANCELLED]: ACCELERATOR_BROKER_STATE.CANCELLED,
  [ACCELERATOR_BROKER_REASON.STATE_UNKNOWN]: ACCELERATOR_BROKER_STATE.UNKNOWN,
});
const ALLOWED_TRANSITIONS = Object.freeze({
  [ACCELERATOR_BROKER_STATE.ACCEPTED]: new Set([
    ACCELERATOR_BROKER_STATE.ACCEPTED,
    ACCELERATOR_BROKER_STATE.RUNNING,
    ACCELERATOR_BROKER_STATE.SUCCEEDED,
    ACCELERATOR_BROKER_STATE.FAILED,
    ACCELERATOR_BROKER_STATE.CANCELLED,
    ACCELERATOR_BROKER_STATE.UNKNOWN,
  ]),
  [ACCELERATOR_BROKER_STATE.RUNNING]: new Set([
    ACCELERATOR_BROKER_STATE.RUNNING,
    ACCELERATOR_BROKER_STATE.SUCCEEDED,
    ACCELERATOR_BROKER_STATE.FAILED,
    ACCELERATOR_BROKER_STATE.CANCELLED,
    ACCELERATOR_BROKER_STATE.UNKNOWN,
  ]),
  [ACCELERATOR_BROKER_STATE.UNKNOWN]: new Set([
    ACCELERATOR_BROKER_STATE.UNKNOWN,
    ACCELERATOR_BROKER_STATE.ACCEPTED,
    ACCELERATOR_BROKER_STATE.RUNNING,
    ACCELERATOR_BROKER_STATE.SUCCEEDED,
    ACCELERATOR_BROKER_STATE.FAILED,
    ACCELERATOR_BROKER_STATE.CANCELLED,
  ]),
});

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function exactIdentity(raw, name, identityKey = 'identity') {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set([identityKey, 'generation']), name);
  return Object.freeze({
    [identityKey]: safeId(value[identityKey], `${name}.${identityKey}`),
    generation: safeId(value.generation, `${name}.generation`),
  });
}

function normalizeBinding(raw, name = 'accelerator broker binding') {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['profile', 'environment', 'backend', 'session']), name);
  return Object.freeze({
    profile: safeId(value.profile, `${name}.profile`),
    environment: exactIdentity(value.environment, `${name}.environment`),
    backend: exactIdentity(value.backend, `${name}.backend`, 'subject'),
    session: exactIdentity(value.session, `${name}.session`),
  });
}

function u32Vector(raw, name) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CANARY_VECTOR_LENGTH) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(raw.map((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
      throw new TypeError(`${name}[${index}] is invalid`);
    }
    return value;
  }));
}

function normalizeInput(raw) {
  const value = requireObject(raw, 'accelerator broker execute.input');
  onlyKeys(value, new Set(['left', 'right']), 'accelerator broker execute.input');
  const left = u32Vector(value.left, 'accelerator broker execute.input.left');
  const right = u32Vector(value.right, 'accelerator broker execute.input.right');
  if (left.length !== right.length) throw new TypeError('accelerator broker execute input vector lengths must match');
  return Object.freeze({ left, right });
}

function normalizeResult(raw) {
  const value = requireObject(raw, 'accelerator broker result');
  onlyKeys(value, new Set(['values']), 'accelerator broker result');
  return Object.freeze({ values: u32Vector(value.values, 'accelerator broker result.values') });
}

function sha256(domain, value) {
  const hex = createHash('sha256').update(domain).update('\0').update(JSON.stringify(value)).digest('hex');
  return `sha256-${hex}`;
}

function normalizeOperation(value) {
  const operation = safeId(value, 'accelerator broker execute.operation');
  if (!Object.values(ACCELERATOR_BROKER_OPERATION).includes(operation)) {
    throw new TypeError('accelerator broker execute.operation is unsupported');
  }
  return operation;
}

export function normalizeAcceleratorBrokerExecuteRequest(raw) {
  const value = requireObject(raw, 'accelerator broker execute');
  onlyKeys(value, new Set([
    'protocol', 'requestId', 'executionId', 'binding', 'api', 'topology', 'operation', 'input',
  ]), 'accelerator broker execute');
  if (value.protocol !== ACCELERATOR_BROKER_EXECUTE_PROTOCOL) throw new TypeError('accelerator broker execute protocol is unsupported');
  if (value.api !== 'cuda') throw new TypeError('accelerator broker execute.api is unsupported');
  if (value.topology !== COMPUTE_TOPOLOGY.HOST_RETAINED) throw new TypeError('accelerator broker execute.topology is unsupported');
  return Object.freeze({
    protocol: ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
    requestId: safeId(value.requestId, 'accelerator broker execute.requestId'),
    executionId: safeId(value.executionId, 'accelerator broker execute.executionId'),
    binding: normalizeBinding(value.binding),
    api: 'cuda',
    topology: COMPUTE_TOPOLOGY.HOST_RETAINED,
    operation: normalizeOperation(value.operation),
    input: normalizeInput(value.input),
  });
}

export function digestAcceleratorBrokerExecuteRequest(raw) {
  return sha256('devbridge/accelerator-broker-execute-digest-v1', normalizeAcceleratorBrokerExecuteRequest(raw));
}

export function classifyAcceleratorBrokerExecuteReplay(rawExisting, rawIncoming) {
  const existing = normalizeAcceleratorBrokerExecuteRequest(rawExisting);
  const incoming = normalizeAcceleratorBrokerExecuteRequest(rawIncoming);
  const sameRequestScope = existing.requestId === incoming.requestId
    && existing.binding.session.identity === incoming.binding.session.identity
    && existing.binding.session.generation === incoming.binding.session.generation;
  if (!sameRequestScope) {
    return Object.freeze({ sameRequestScope: false, replay: false, conflict: false });
  }
  const replay = digestAcceleratorBrokerExecuteRequest(existing) === digestAcceleratorBrokerExecuteRequest(incoming);
  return Object.freeze({ sameRequestScope: true, replay, conflict: !replay });
}

export function normalizeAcceleratorBrokerCancelRequest(raw) {
  const value = requireObject(raw, 'accelerator broker cancel');
  onlyKeys(value, new Set(['protocol', 'cancelId', 'requestId', 'executionId', 'requestDigest', 'binding']), 'accelerator broker cancel');
  if (value.protocol !== ACCELERATOR_BROKER_CANCEL_PROTOCOL) throw new TypeError('accelerator broker cancel protocol is unsupported');
  return Object.freeze({
    protocol: ACCELERATOR_BROKER_CANCEL_PROTOCOL,
    cancelId: safeId(value.cancelId, 'accelerator broker cancel.cancelId'),
    requestId: safeId(value.requestId, 'accelerator broker cancel.requestId'),
    executionId: safeId(value.executionId, 'accelerator broker cancel.executionId'),
    requestDigest: digest(value.requestDigest, 'accelerator broker cancel.requestDigest'),
    binding: normalizeBinding(value.binding),
  });
}

export function digestAcceleratorBrokerCancelRequest(raw) {
  return sha256('devbridge/accelerator-broker-cancel-digest-v1', normalizeAcceleratorBrokerCancelRequest(raw));
}

export function digestAcceleratorBrokerResult(raw) {
  return sha256('devbridge/accelerator-broker-result-digest-v1', normalizeResult(raw));
}

function normalizeState(value) {
  const state = safeId(value, 'accelerator broker observation.state');
  if (!Object.values(ACCELERATOR_BROKER_STATE).includes(state)) throw new TypeError('accelerator broker observation.state is unsupported');
  return state;
}

function normalizeReason(value, state) {
  if ([ACCELERATOR_BROKER_STATE.ACCEPTED, ACCELERATOR_BROKER_STATE.RUNNING, ACCELERATOR_BROKER_STATE.SUCCEEDED].includes(state)) {
    if (value != null) throw new TypeError(`accelerator broker observation ${state} cannot carry a reason`);
    return null;
  }
  const reason = safeId(value, 'accelerator broker observation.reason');
  if (REASON_RULES[reason] !== state) throw new TypeError('accelerator broker observation.reason is inconsistent with state');
  return reason;
}

export function normalizeAcceleratorBrokerObservation(raw) {
  const value = requireObject(raw, 'accelerator broker observation');
  onlyKeys(value, new Set([
    'protocol', 'requestId', 'executionId', 'requestDigest', 'binding', 'api', 'topology', 'operation',
    'state', 'reason', 'result', 'resultDigest',
  ]), 'accelerator broker observation');
  if (value.protocol !== ACCELERATOR_BROKER_OBSERVATION_PROTOCOL) throw new TypeError('accelerator broker observation protocol is unsupported');
  if (value.api !== 'cuda') throw new TypeError('accelerator broker observation.api is unsupported');
  if (value.topology !== COMPUTE_TOPOLOGY.HOST_RETAINED) throw new TypeError('accelerator broker observation.topology is unsupported');
  const state = normalizeState(value.state);
  const reason = normalizeReason(value.reason, state);
  const operation = normalizeOperation(value.operation);
  let result = null;
  let resultDigest = null;
  if (state === ACCELERATOR_BROKER_STATE.SUCCEEDED) {
    result = normalizeResult(value.result);
    resultDigest = digest(value.resultDigest, 'accelerator broker observation.resultDigest');
    const expected = digestAcceleratorBrokerResult(result);
    if (resultDigest !== expected) throw new TypeError('accelerator broker observation.resultDigest does not match result');
  } else if (value.result != null || value.resultDigest != null) {
    throw new TypeError('non-success accelerator broker observation cannot carry a result');
  }
  return Object.freeze({
    protocol: ACCELERATOR_BROKER_OBSERVATION_PROTOCOL,
    requestId: safeId(value.requestId, 'accelerator broker observation.requestId'),
    executionId: safeId(value.executionId, 'accelerator broker observation.executionId'),
    requestDigest: digest(value.requestDigest, 'accelerator broker observation.requestDigest'),
    binding: normalizeBinding(value.binding),
    api: 'cuda',
    topology: COMPUTE_TOPOLOGY.HOST_RETAINED,
    operation,
    state,
    reason,
    result,
    resultDigest,
  });
}

export function createAcceleratorBrokerObservation(raw) {
  const resultDigest = raw?.state === ACCELERATOR_BROKER_STATE.SUCCEEDED
    ? digestAcceleratorBrokerResult(raw.result)
    : null;
  return normalizeAcceleratorBrokerObservation({
    ...raw,
    protocol: ACCELERATOR_BROKER_OBSERVATION_PROTOCOL,
    resultDigest,
  });
}

export function matchAcceleratorBrokerBinding(rawBinding, rawExpectedBinding) {
  const binding = normalizeBinding(rawBinding, 'accelerator broker binding');
  const expected = normalizeBinding(rawExpectedBinding, 'accelerator broker expected binding');
  const mismatches = [];
  if (binding.profile !== expected.profile) mismatches.push('profile');
  if (binding.environment.identity !== expected.environment.identity) mismatches.push('environment-identity');
  if (binding.environment.generation !== expected.environment.generation) mismatches.push('environment-generation');
  if (binding.backend.subject !== expected.backend.subject) mismatches.push('backend-subject');
  if (binding.backend.generation !== expected.backend.generation) mismatches.push('backend-generation');
  if (binding.session.identity !== expected.session.identity) mismatches.push('session-identity');
  if (binding.session.generation !== expected.session.generation) mismatches.push('session-generation');
  return Object.freeze({
    protocol: ACCELERATOR_BROKER_BINDING_MATCH_PROTOCOL,
    matched: mismatches.length === 0,
    binding,
    expected,
    mismatches: Object.freeze(mismatches),
  });
}

function sameExecution(left, right) {
  return left.requestId === right.requestId
    && left.executionId === right.executionId
    && left.requestDigest === right.requestDigest
    && left.api === right.api
    && left.topology === right.topology
    && left.operation === right.operation
    && JSON.stringify(left.binding) === JSON.stringify(right.binding);
}

export function isAcceleratorBrokerTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function assertAcceleratorBrokerObservationTransition(rawPrevious, rawNext) {
  const previous = normalizeAcceleratorBrokerObservation(rawPrevious);
  const next = normalizeAcceleratorBrokerObservation(rawNext);
  if (!sameExecution(previous, next)) throw new TypeError('accelerator broker observation transition changed execution identity');
  if (TERMINAL_STATES.has(previous.state)) {
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new TypeError('terminal accelerator broker observation is immutable');
    }
    return next;
  }
  const allowed = ALLOWED_TRANSITIONS[previous.state];
  if (!allowed?.has(next.state)) throw new TypeError(`accelerator broker observation transition ${previous.state}->${next.state} is invalid`);
  return next;
}
