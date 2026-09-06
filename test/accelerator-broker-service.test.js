import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcceleratorBrokerService,
  ACCELERATOR_BROKER_SERVICE_KIND,
  ACCELERATOR_BROKER_SERVICE_MAX_FRAME_BYTES,
  ACCELERATOR_BROKER_SERVICE_OUTCOME,
  ACCELERATOR_BROKER_SERVICE_PROTOCOL,
  decodeAcceleratorBrokerServiceRequestFrame,
  decodeAcceleratorBrokerServiceResponseFrame,
  encodeAcceleratorBrokerServiceRequestFrame,
  encodeAcceleratorBrokerServiceResponseFrame,
  handleAcceleratorBrokerServiceFrame,
  normalizeAcceleratorBrokerServiceRequest,
} from '../src/runtime/accelerator-broker-service.js';
import {
  ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
  ACCELERATOR_BROKER_CANCEL_PROTOCOL,
  ACCELERATOR_BROKER_OPERATION,
  ACCELERATOR_BROKER_STATE,
  createAcceleratorBrokerObservation,
  digestAcceleratorBrokerExecuteRequest,
} from '../src/runtime/accelerator-broker-protocol.js';

function exactId(character = 'a') {
  return character.repeat(160);
}

function binding(generation = 'session-generation-1') {
  return {
    profile: 'profile-cuda',
    environment: { identity: 'environment-1', generation: 'environment-generation-1' },
    backend: { subject: 'backend-1', generation: 'backend-generation-1' },
    session: { identity: 'session-1', generation },
  };
}

function executeRequest({ left = [1, 2], right = [3, 4], exactMaximumIds = false } = {}) {
  const selectedBinding = exactMaximumIds ? {
    profile: exactId('p'),
    environment: { identity: exactId('e'), generation: exactId('f') },
    backend: { subject: exactId('b'), generation: exactId('c') },
    session: { identity: exactId('s'), generation: exactId('g') },
  } : binding();
  return {
    protocol: ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
    requestId: exactMaximumIds ? exactId('r') : 'request-1',
    executionId: exactMaximumIds ? exactId('x') : 'execution-1',
    binding: selectedBinding,
    api: 'cuda',
    topology: 'host-retained',
    operation: ACCELERATOR_BROKER_OPERATION.CUDA_CANARY_U32_ADD_V1,
    input: { left, right },
  };
}

function succeeded(request) {
  return createAcceleratorBrokerObservation({
    requestId: request.requestId,
    executionId: request.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(request),
    binding: request.binding,
    api: request.api,
    topology: request.topology,
    operation: request.operation,
    state: ACCELERATOR_BROKER_STATE.SUCCEEDED,
    reason: null,
    result: {
      values: request.input.left.map((value, index) => (value + request.input.right[index]) >>> 0),
    },
  });
}

function cancelRequest(request) {
  return {
    protocol: ACCELERATOR_BROKER_CANCEL_PROTOCOL,
    cancelId: 'cancel-1',
    requestId: request.requestId,
    executionId: request.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(request),
    binding: request.binding,
  };
}

function serviceRequest(kind, body) {
  return { protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL, kind, body };
}

test('maximum valid sealed execute request and result fit the service wire bound', () => {
  const values = Array.from({ length: 4096 }, () => 0xffff_ffff);
  const request = serviceRequest(
    ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE,
    executeRequest({ left: values, right: values, exactMaximumIds: true }),
  );
  const frame = encodeAcceleratorBrokerServiceRequestFrame(request);
  assert.ok(frame.length <= ACCELERATOR_BROKER_SERVICE_MAX_FRAME_BYTES + 1);
  assert.deepEqual(decodeAcceleratorBrokerServiceRequestFrame(frame), normalizeAcceleratorBrokerServiceRequest(request));
  const responseFrame = encodeAcceleratorBrokerServiceResponseFrame({
    protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL,
    kind: ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE,
    outcome: ACCELERATOR_BROKER_SERVICE_OUTCOME.OBSERVATION,
    observation: succeeded(request.body),
  });
  assert.ok(responseFrame.length <= ACCELERATOR_BROKER_SERVICE_MAX_FRAME_BYTES + 1);
  assert.equal(decodeAcceleratorBrokerServiceResponseFrame(responseFrame).outcome, ACCELERATOR_BROKER_SERVICE_OUTCOME.OBSERVATION);
});

test('service delegates valid execute exactly once and normalizes the observation', async () => {
  const request = executeRequest();
  const expected = succeeded(request);
  const calls = [];
  const service = new AcceleratorBrokerService({
    broker: {
      async execute(value) { calls.push(['execute', value]); return expected; },
      async observe() { throw new Error('unexpected observe'); },
      async cancel() { throw new Error('unexpected cancel'); },
    },
  });
  const response = await service.handle(serviceRequest(ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE, request));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'execute');
  assert.deepEqual(calls[0][1], request);
  assert.equal(response.outcome, ACCELERATOR_BROKER_SERVICE_OUTCOME.OBSERVATION);
  assert.deepEqual(response.observation, expected);
});

test('observe and cancel project observations when present', async () => {
  const request = executeRequest();
  const expected = succeeded(request);
  const cancel = cancelRequest(request);
  const service = new AcceleratorBrokerService({
    broker: {
      async execute() { throw new Error('unexpected execute'); },
      async observe(value) { assert.deepEqual(value, request); return expected; },
      async cancel(value) { assert.deepEqual(value, cancel); return expected; },
    },
  });
  const observed = await service.handle(serviceRequest(ACCELERATOR_BROKER_SERVICE_KIND.OBSERVE, request));
  const cancelled = await service.handle(serviceRequest(ACCELERATOR_BROKER_SERVICE_KIND.CANCEL, cancel));
  assert.equal(observed.outcome, ACCELERATOR_BROKER_SERVICE_OUTCOME.OBSERVATION);
  assert.equal(cancelled.outcome, ACCELERATOR_BROKER_SERVICE_OUTCOME.OBSERVATION);
  assert.deepEqual(observed.observation, expected);
  assert.deepEqual(cancelled.observation, expected);
});

test('unknown observe and cancel collapse to bounded absent responses', async () => {
  const request = executeRequest();
  const service = new AcceleratorBrokerService({
    broker: {
      async execute() { throw new Error('unexpected execute'); },
      async observe() { return null; },
      async cancel() { return null; },
    },
  });
  const observed = await service.handle(serviceRequest(ACCELERATOR_BROKER_SERVICE_KIND.OBSERVE, request));
  const cancelled = await service.handle(serviceRequest(ACCELERATOR_BROKER_SERVICE_KIND.CANCEL, cancelRequest(request)));
  for (const response of [observed, cancelled]) {
    assert.equal(response.outcome, ACCELERATOR_BROKER_SERVICE_OUTCOME.ABSENT);
    assert.equal(response.observation, null);
  }
});

test('execute cannot be projected as absent', async () => {
  const service = new AcceleratorBrokerService({
    broker: {
      async execute() { return null; },
      async observe() { return null; },
      async cancel() { return null; },
    },
  });
  await assert.rejects(
    service.handle(serviceRequest(ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE, executeRequest())),
    /operation is unavailable/u,
  );
});

test('unknown service kinds and authority-shaped extensions fail before broker invocation', async () => {
  let calls = 0;
  const service = new AcceleratorBrokerService({
    broker: {
      async execute() { calls += 1; return null; },
      async observe() { calls += 1; return null; },
      async cancel() { calls += 1; return null; },
    },
  });
  await assert.rejects(service.handle(serviceRequest('retire', executeRequest())), /kind is unsupported/u);
  await assert.rejects(service.handle({
    ...serviceRequest(ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE, executeRequest()),
    endpoint: 'guest-selected',
  }), /endpoint is not allowed/u);
  await assert.rejects(service.handle(serviceRequest(ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE, {
    ...executeRequest(),
    hostPath: 'C:/host',
  })), /hostPath is not allowed/u);
  assert.equal(calls, 0);
});

test('wire framing rejects missing termination, malformed, invalid UTF-8, multiple, trailing, and oversized input', () => {
  const frame = encodeAcceleratorBrokerServiceRequestFrame(
    serviceRequest(ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE, executeRequest()),
  );
  assert.throws(() => decodeAcceleratorBrokerServiceRequestFrame(frame.subarray(0, -1)), /exactly one/u);
  assert.throws(() => decodeAcceleratorBrokerServiceRequestFrame(Buffer.from('{]\n')), /valid JSON/u);
  assert.throws(() => decodeAcceleratorBrokerServiceRequestFrame(Buffer.from([0xc3, 0x28, 0x0a])), /valid UTF-8/u);
  assert.throws(() => decodeAcceleratorBrokerServiceRequestFrame(Buffer.concat([frame, frame])), /exactly one/u);
  assert.throws(() => decodeAcceleratorBrokerServiceRequestFrame(Buffer.concat([frame, Buffer.from('x')])), /exactly one/u);
  const oversized = Buffer.alloc(ACCELERATOR_BROKER_SERVICE_MAX_FRAME_BYTES + 2, 0x20);
  oversized[oversized.length - 1] = 0x0a;
  assert.throws(() => decodeAcceleratorBrokerServiceRequestFrame(oversized), /frame bound/u);
});

test('response wire framing round-trips normalized observations and absent results', () => {
  const request = executeRequest();
  const observationFrame = encodeAcceleratorBrokerServiceResponseFrame({
    protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL,
    kind: ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE,
    outcome: ACCELERATOR_BROKER_SERVICE_OUTCOME.OBSERVATION,
    observation: succeeded(request),
  });
  assert.equal(decodeAcceleratorBrokerServiceResponseFrame(observationFrame).outcome, ACCELERATOR_BROKER_SERVICE_OUTCOME.OBSERVATION);
  const absentFrame = encodeAcceleratorBrokerServiceResponseFrame({
    protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL,
    kind: ACCELERATOR_BROKER_SERVICE_KIND.OBSERVE,
    outcome: ACCELERATOR_BROKER_SERVICE_OUTCOME.ABSENT,
    observation: null,
  });
  assert.equal(decodeAcceleratorBrokerServiceResponseFrame(absentFrame).outcome, ACCELERATOR_BROKER_SERVICE_OUTCOME.ABSENT);
});

test('malformed controller output and controller failure fail closed without leaking effect evidence or private detail', async () => {
  const request = serviceRequest(ACCELERATOR_BROKER_SERVICE_KIND.EXECUTE, executeRequest());
  const malformed = new AcceleratorBrokerService({
    broker: {
      async execute() { return { state: 'succeeded' }; },
      async observe() { return null; },
      async cancel() { return null; },
    },
  });
  await assert.rejects(malformed.handle(request), /operation is unavailable/u);

  const failed = new AcceleratorBrokerService({
    broker: {
      async execute() { throw new Error('private host detail'); },
      async observe() { return null; },
      async cancel() { return null; },
    },
  });
  await assert.rejects(
    handleAcceleratorBrokerServiceFrame(failed, encodeAcceleratorBrokerServiceRequestFrame(request)),
    (error) => error?.message === 'accelerator broker service operation is unavailable'
      && !String(error).includes('private host detail'),
  );
});
