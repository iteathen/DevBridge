import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCELERATOR_BROKER_CANCEL_PROTOCOL,
  ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
  ACCELERATOR_BROKER_OPERATION,
  ACCELERATOR_BROKER_STATE,
  createAcceleratorBrokerObservation,
  digestAcceleratorBrokerExecuteRequest,
} from '../src/runtime/accelerator-broker-protocol.js';
import {
  ACCELERATOR_BROKER_LEDGER_PROTOCOL,
  acceleratorBrokerCancelLedgerKey,
  acceleratorBrokerLedgerKey,
  advanceAcceleratorBrokerLedgerRecord,
  createAcceleratorBrokerLedgerRecord,
  normalizeAcceleratorBrokerLedgerRecord,
} from '../src/runtime/accelerator-broker-ledger.js';

function binding() {
  return {
    profile: 'profile.cuda',
    environment: { identity: 'environment.cuda', generation: 'environment-generation-1' },
    backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-1' },
    session: { identity: 'broker-session-a', generation: 'broker-session-generation-1' },
  };
}

function request() {
  return {
    protocol: ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
    requestId: 'request-1',
    executionId: 'execution-1',
    binding: binding(),
    api: 'cuda',
    topology: 'host-retained',
    operation: ACCELERATOR_BROKER_OPERATION.CUDA_CANARY_U32_ADD_V1,
    input: { left: [1, 0xffff_ffff], right: [2, 1] },
  };
}

function observation(state = ACCELERATOR_BROKER_STATE.ACCEPTED, extra = {}) {
  const value = request();
  return createAcceleratorBrokerObservation({
    requestId: value.requestId,
    executionId: value.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(value),
    binding: value.binding,
    api: value.api,
    topology: value.topology,
    operation: value.operation,
    state,
    reason: null,
    result: null,
    ...extra,
  });
}

function cancel(cancelId = 'cancel-1') {
  const value = request();
  return {
    protocol: ACCELERATOR_BROKER_CANCEL_PROTOCOL,
    cancelId,
    requestId: value.requestId,
    executionId: value.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(value),
    binding: value.binding,
  };
}

test('ledger record binds normalized request, digest, and observation exactly', () => {
  const record = createAcceleratorBrokerLedgerRecord({ request: request(), observation: observation() });
  assert.equal(record.protocol, ACCELERATOR_BROKER_LEDGER_PROTOCOL);
  assert.equal(record.revision, 1);
  assert.equal(record.requestDigest, digestAcceleratorBrokerExecuteRequest(request()));
  assert.equal(record.observation.state, 'accepted');
  assert.equal(record.cancelIntent, null);
  assert.equal(Object.isFrozen(record), true);
});

test('ledger keys are scoped by exact session generation and request identity', () => {
  assert.deepEqual(acceleratorBrokerLedgerKey(request()), {
    sessionIdentity: 'broker-session-a',
    sessionGeneration: 'broker-session-generation-1',
    requestId: 'request-1',
  });
  assert.deepEqual(acceleratorBrokerCancelLedgerKey(cancel()), acceleratorBrokerLedgerKey(request()));
});

test('ledger normalization rejects mismatched request digest or observation ownership', () => {
  const record = createAcceleratorBrokerLedgerRecord({ request: request(), observation: observation() });
  assert.throws(() => normalizeAcceleratorBrokerLedgerRecord({ ...record, requestDigest: `sha256-${'0'.repeat(64)}` }), /digest does not match/u);
  const other = request();
  other.executionId = 'execution-2';
  const wrongObservation = createAcceleratorBrokerObservation({
    ...observation(),
    executionId: 'execution-2',
  });
  assert.throws(() => normalizeAcceleratorBrokerLedgerRecord({ ...record, observation: wrongObservation }), /does not belong/u);
});

test('ledger advances only through valid observation transitions and monotonic revision', () => {
  const first = createAcceleratorBrokerLedgerRecord({ request: request(), observation: observation() });
  const running = observation(ACCELERATOR_BROKER_STATE.RUNNING);
  const second = advanceAcceleratorBrokerLedgerRecord(first, { observation: running });
  assert.equal(second.revision, 2);
  assert.equal(second.observation.state, 'running');
  const succeeded = observation(ACCELERATOR_BROKER_STATE.SUCCEEDED, { result: { values: [3, 0] } });
  const third = advanceAcceleratorBrokerLedgerRecord(second, { observation: succeeded });
  assert.equal(third.revision, 3);
  assert.equal(third.observation.state, 'succeeded');
  assert.throws(() => advanceAcceleratorBrokerLedgerRecord(third, { observation: observation(ACCELERATOR_BROKER_STATE.RUNNING) }), /terminal .* immutable/u);
});

test('cancellation intent is durable, exact, and immutable once recorded', () => {
  const first = createAcceleratorBrokerLedgerRecord({ request: request(), observation: observation(ACCELERATOR_BROKER_STATE.RUNNING) });
  const second = advanceAcceleratorBrokerLedgerRecord(first, { cancel: cancel() });
  assert.equal(second.revision, 2);
  assert.equal(second.cancelIntent.request.cancelId, 'cancel-1');
  const replay = advanceAcceleratorBrokerLedgerRecord(second, { cancel: cancel() });
  assert.equal(replay.cancelIntent.digest, second.cancelIntent.digest);
  assert.throws(() => advanceAcceleratorBrokerLedgerRecord(second, { cancel: cancel('cancel-2') }), /cancellation intent is immutable/u);
});
