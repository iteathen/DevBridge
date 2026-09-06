import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcceleratorBrokerEndpointAttachment,
  ACCELERATOR_BROKER_VM_SERVICE_PORT,
} from '../src/runtime/accelerator-broker-endpoint-attachment.js';
import {
  AcceleratorBrokerService,
  ACCELERATOR_BROKER_SERVICE_KIND,
  ACCELERATOR_BROKER_SERVICE_OUTCOME,
  ACCELERATOR_BROKER_SERVICE_PROTOCOL,
  decodeAcceleratorBrokerServiceResponseFrame,
  encodeAcceleratorBrokerServiceRequestFrame,
} from '../src/runtime/accelerator-broker-service.js';
import { ACCELERATOR_BROKER_EXECUTE_PROTOCOL } from '../src/runtime/accelerator-broker-protocol.js';

function binding(overrides = {}) {
  return {
    profile: overrides.profile ?? 'profile-cuda',
    environment: {
      identity: overrides.environmentIdentity ?? 'environment-1',
      generation: overrides.environmentGeneration ?? 'environment-generation-1',
    },
    backend: {
      subject: overrides.backendSubject ?? 'backend-1',
      generation: overrides.backendGeneration ?? 'backend-generation-1',
    },
    session: {
      identity: overrides.sessionIdentity ?? 'session-1',
      generation: overrides.sessionGeneration ?? 'session-generation-1',
    },
  };
}

function executeRequest(selectedBinding = binding()) {
  return {
    protocol: ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
    requestId: 'request-1',
    executionId: 'execution-1',
    binding: selectedBinding,
    api: 'cuda',
    topology: 'host-retained',
    operation: 'cuda.canary.u32-add-v1',
    input: { left: [1, 2], right: [3, 4] },
  };
}

function frame(kind, body) {
  return encodeAcceleratorBrokerServiceRequestFrame({
    protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL,
    kind,
    body,
  });
}

function observingService(calls) {
  return new AcceleratorBrokerService({
    broker: {
      async execute() { calls.push('execute'); throw new Error('unexpected execute'); },
      async observe() { calls.push('observe'); return null; },
      async cancel() { calls.push('cancel'); return null; },
    },
  });
}

test('endpoint attachment uses a stable high VM service port', () => {
  assert.equal(ACCELERATOR_BROKER_VM_SERVICE_PORT, 55_005);
  assert.ok(ACCELERATOR_BROKER_VM_SERVICE_PORT >= 1024);
  assert.ok(ACCELERATOR_BROKER_VM_SERVICE_PORT < 0xffff_ffff);
});

test('exact attachment binding admits one normalized service frame', async () => {
  const calls = [];
  const expectedBinding = binding();
  const attachment = new AcceleratorBrokerEndpointAttachment({
    binding: expectedBinding,
    service: observingService(calls),
  });
  const responseFrame = await attachment.handleFrame(frame(
    ACCELERATOR_BROKER_SERVICE_KIND.OBSERVE,
    executeRequest(expectedBinding),
  ));
  const response = decodeAcceleratorBrokerServiceResponseFrame(responseFrame);
  assert.deepEqual(calls, ['observe']);
  assert.equal(response.kind, ACCELERATOR_BROKER_SERVICE_KIND.OBSERVE);
  assert.equal(response.outcome, ACCELERATOR_BROKER_SERVICE_OUTCOME.ABSENT);
  assert.equal(response.observation, null);
});

test('every exact binding dimension is an endpoint attachment gate', async () => {
  const mutations = [
    { profile: 'profile-other' },
    { environmentIdentity: 'environment-other' },
    { environmentGeneration: 'environment-generation-other' },
    { backendSubject: 'backend-other' },
    { backendGeneration: 'backend-generation-other' },
    { sessionIdentity: 'session-other' },
    { sessionGeneration: 'session-generation-other' },
  ];
  for (const mutation of mutations) {
    const calls = [];
    const attachment = new AcceleratorBrokerEndpointAttachment({
      binding: binding(),
      service: observingService(calls),
    });
    await assert.rejects(
      attachment.handleFrame(frame(ACCELERATOR_BROKER_SERVICE_KIND.OBSERVE, executeRequest(binding(mutation)))),
      (error) => error?.message === 'accelerator broker endpoint is unavailable',
    );
    assert.deepEqual(calls, []);
  }
});

test('malformed frames fail generically before service invocation', async () => {
  const calls = [];
  const attachment = new AcceleratorBrokerEndpointAttachment({ binding: binding(), service: observingService(calls) });
  await assert.rejects(
    attachment.handleFrame(Buffer.from('{]\n')),
    (error) => error?.message === 'accelerator broker endpoint is unavailable',
  );
  assert.deepEqual(calls, []);
});

test('downstream service failure is not widened at the endpoint', async () => {
  const attachment = new AcceleratorBrokerEndpointAttachment({
    binding: binding(),
    service: {
      async handle() { throw new Error('private endpoint detail'); },
    },
  });
  await assert.rejects(
    attachment.handleFrame(frame(ACCELERATOR_BROKER_SERVICE_KIND.OBSERVE, executeRequest())),
    (error) => error?.message === 'accelerator broker endpoint is unavailable'
      && !String(error).includes('private endpoint detail'),
  );
});
