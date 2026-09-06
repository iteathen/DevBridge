import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCELERATOR_BROKER_CANCEL_PROTOCOL,
  ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
  ACCELERATOR_BROKER_OPERATION,
  ACCELERATOR_BROKER_REASON,
  ACCELERATOR_BROKER_STATE,
  assertAcceleratorBrokerObservationTransition,
  classifyAcceleratorBrokerExecuteReplay,
  createAcceleratorBrokerObservation,
  digestAcceleratorBrokerExecuteRequest,
  digestAcceleratorBrokerResult,
  matchAcceleratorBrokerBinding,
  normalizeAcceleratorBrokerCancelRequest,
  normalizeAcceleratorBrokerExecuteRequest,
  normalizeAcceleratorBrokerObservation,
} from '../src/runtime/accelerator-broker-protocol.js';

function binding(overrides = {}) {
  return {
    profile: 'profile.cuda',
    environment: { identity: 'environment.cuda', generation: 'environment-generation-1' },
    backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-1' },
    session: { identity: 'broker-session-a', generation: 'broker-session-generation-1' },
    ...overrides,
  };
}

function execute(overrides = {}) {
  return {
    protocol: ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
    requestId: 'request-1',
    executionId: 'execution-1',
    binding: binding(),
    api: 'cuda',
    topology: 'host-retained',
    operation: ACCELERATOR_BROKER_OPERATION.CUDA_CANARY_U32_ADD_V1,
    input: { left: [1, 0xffff_ffff], right: [2, 1] },
    ...overrides,
  };
}

function observation(request, state, extra = {}) {
  return createAcceleratorBrokerObservation({
    requestId: request.requestId,
    executionId: request.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(request),
    binding: request.binding,
    api: request.api,
    topology: request.topology,
    operation: request.operation,
    state,
    reason: null,
    result: null,
    ...extra,
  });
}

test('normalizes only the fixed bounded Phase-3 CUDA canary request', () => {
  const result = normalizeAcceleratorBrokerExecuteRequest(execute());
  assert.equal(result.operation, 'cuda.canary.u32-add-v1');
  assert.deepEqual(result.input.left, [1, 0xffff_ffff]);
  assert.deepEqual(result.input.right, [2, 1]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.binding), true);
  assert.equal(Object.isFrozen(result.input.left), true);
});

test('rejects arbitrary operation, execution, and extension surfaces', () => {
  assert.throws(() => normalizeAcceleratorBrokerExecuteRequest(execute({ operation: 'cuda.launch-arbitrary-v1' })), /operation is unsupported/u);
  assert.throws(() => normalizeAcceleratorBrokerExecuteRequest({ ...execute(), command: 'anything' }), /command is not allowed/u);
  assert.throws(() => normalizeAcceleratorBrokerExecuteRequest({ ...execute(), module: 'anything' }), /module is not allowed/u);
  assert.throws(() => normalizeAcceleratorBrokerExecuteRequest({ ...execute(), device: 'anything' }), /device is not allowed/u);
});

test('bounds canary vectors and requires exact u32 pairs', () => {
  assert.throws(() => normalizeAcceleratorBrokerExecuteRequest(execute({ input: { left: [], right: [] } })), /left is invalid/u);
  assert.throws(() => normalizeAcceleratorBrokerExecuteRequest(execute({ input: { left: [1], right: [1, 2] } })), /lengths must match/u);
  assert.throws(() => normalizeAcceleratorBrokerExecuteRequest(execute({ input: { left: [-1], right: [0] } })), /left\[0\] is invalid/u);
  assert.throws(() => normalizeAcceleratorBrokerExecuteRequest(execute({ input: { left: [0x1_0000_0000], right: [0] } })), /left\[0\] is invalid/u);
  const tooLarge = Array.from({ length: 4097 }, () => 0);
  assert.throws(() => normalizeAcceleratorBrokerExecuteRequest(execute({ input: { left: tooLarge, right: tooLarge } })), /left is invalid/u);
});

test('binding comparison keeps authority context exact and exposes only closed mismatch names', () => {
  const expected = binding();
  assert.deepEqual(matchAcceleratorBrokerBinding(expected, expected).mismatches, []);
  const stale = binding({
    environment: { identity: 'environment.cuda', generation: 'environment-generation-2' },
    backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-2' },
  });
  const result = matchAcceleratorBrokerBinding(stale, expected);
  assert.equal(result.matched, false);
  assert.deepEqual(result.mismatches, ['environment-generation', 'backend-generation']);
});

test('request digest is stable for exact replay and changes with payload or generation', () => {
  const first = execute();
  const equivalent = execute();
  assert.equal(digestAcceleratorBrokerExecuteRequest(first), digestAcceleratorBrokerExecuteRequest(equivalent));
  assert.notEqual(digestAcceleratorBrokerExecuteRequest(first), digestAcceleratorBrokerExecuteRequest(execute({ input: { left: [1, 4], right: [2, 1] } })));
  assert.notEqual(digestAcceleratorBrokerExecuteRequest(first), digestAcceleratorBrokerExecuteRequest(execute({
    binding: binding({ backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-2' } }),
  })));
});

test('replay classification distinguishes exact replay from conflicting reuse within a session', () => {
  assert.deepEqual(classifyAcceleratorBrokerExecuteReplay(execute(), execute()), {
    sameRequestScope: true, replay: true, conflict: false,
  });
  assert.deepEqual(classifyAcceleratorBrokerExecuteReplay(execute(), execute({ executionId: 'execution-2' })), {
    sameRequestScope: true, replay: false, conflict: true,
  });
  assert.deepEqual(classifyAcceleratorBrokerExecuteReplay(execute(), execute({ requestId: 'request-2' })), {
    sameRequestScope: false, replay: false, conflict: false,
  });
});

test('cancel request binds exact execution, request digest, and session without extension authority', () => {
  const request = execute();
  const result = normalizeAcceleratorBrokerCancelRequest({
    protocol: ACCELERATOR_BROKER_CANCEL_PROTOCOL,
    cancelId: 'cancel-1',
    requestId: request.requestId,
    executionId: request.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(request),
    binding: request.binding,
  });
  assert.equal(result.cancelId, 'cancel-1');
  assert.throws(() => normalizeAcceleratorBrokerCancelRequest({ ...result, signal: 'SIGKILL' }), /signal is not allowed/u);
});

test('successful observation requires broker-computed result digest and exact execution bindings', () => {
  const request = execute();
  const result = { values: [3, 0] };
  const succeeded = observation(request, ACCELERATOR_BROKER_STATE.SUCCEEDED, { result });
  assert.equal(succeeded.reason, null);
  assert.equal(succeeded.resultDigest, digestAcceleratorBrokerResult(result));
  assert.deepEqual(succeeded.result.values, [3, 0]);
  assert.throws(() => normalizeAcceleratorBrokerObservation({ ...succeeded, resultDigest: `sha256-${'0'.repeat(64)}` }), /does not match result/u);
});

test('observation reasons are closed and state-bound', () => {
  const request = execute();
  const rejected = observation(request, ACCELERATOR_BROKER_STATE.REJECTED, { reason: ACCELERATOR_BROKER_REASON.BINDING_STALE });
  assert.equal(rejected.reason, 'binding-stale');
  assert.throws(() => observation(request, ACCELERATOR_BROKER_STATE.REJECTED, { reason: ACCELERATOR_BROKER_REASON.EXECUTION_FAILED }), /inconsistent with state/u);
  assert.throws(() => observation(request, ACCELERATOR_BROKER_STATE.RUNNING, { reason: ACCELERATOR_BROKER_REASON.STATE_UNKNOWN }), /cannot carry a reason/u);
  assert.throws(() => observation(request, ACCELERATOR_BROKER_STATE.FAILED, { reason: 'driver-crashed-secret-detail' }), /inconsistent with state/u);
});

test('execution observations permit reconciliation while terminal evidence stays immutable', () => {
  const request = execute();
  const accepted = observation(request, ACCELERATOR_BROKER_STATE.ACCEPTED);
  const running = observation(request, ACCELERATOR_BROKER_STATE.RUNNING);
  const unknown = observation(request, ACCELERATOR_BROKER_STATE.UNKNOWN, { reason: ACCELERATOR_BROKER_REASON.STATE_UNKNOWN });
  const succeeded = observation(request, ACCELERATOR_BROKER_STATE.SUCCEEDED, { result: { values: [3, 0] } });
  assert.equal(assertAcceleratorBrokerObservationTransition(accepted, running).state, 'running');
  assert.equal(assertAcceleratorBrokerObservationTransition(running, unknown).state, 'unknown');
  assert.equal(assertAcceleratorBrokerObservationTransition(unknown, succeeded).state, 'succeeded');
  assert.equal(assertAcceleratorBrokerObservationTransition(succeeded, succeeded).state, 'succeeded');
  const altered = observation(request, ACCELERATOR_BROKER_STATE.SUCCEEDED, { result: { values: [3, 1] } });
  assert.throws(() => assertAcceleratorBrokerObservationTransition(succeeded, altered), /terminal .* immutable/u);
});

test('transition cannot change request, backend generation, or execution identity', () => {
  const request = execute();
  const accepted = observation(request, ACCELERATOR_BROKER_STATE.ACCEPTED);
  const differentRequest = execute({ executionId: 'execution-2' });
  const running = observation(differentRequest, ACCELERATOR_BROKER_STATE.RUNNING);
  assert.throws(() => assertAcceleratorBrokerObservationTransition(accepted, running), /changed execution identity/u);
});
