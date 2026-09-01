import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WindowsHyperVAcceleratorBrokerEndpoint,
  WINDOWS_HYPERV_ACCELERATOR_BROKER_ENDPOINT_PROTOCOL,
  windowsHyperVAcceleratorBrokerServiceId,
} from '../src/runtime/providers/windows-hyperv-accelerator-broker-endpoint.js';
import { ACCELERATOR_BROKER_VM_SERVICE_PORT } from '../src/runtime/accelerator-broker-endpoint-attachment.js';
import {
  AcceleratorBrokerService,
  ACCELERATOR_BROKER_SERVICE_KIND,
  ACCELERATOR_BROKER_SERVICE_OUTCOME,
  ACCELERATOR_BROKER_SERVICE_PROTOCOL,
  decodeAcceleratorBrokerServiceResponseFrame,
  encodeAcceleratorBrokerServiceRequestFrame,
} from '../src/runtime/accelerator-broker-service.js';
import { ACCELERATOR_BROKER_EXECUTE_PROTOCOL } from '../src/runtime/accelerator-broker-protocol.js';

const VM_ID = '01234567-89ab-cdef-0123-456789abcdef';
const OTHER_VM_ID = '11234567-89ab-cdef-0123-456789abcdef';

function binding() {
  return {
    profile: 'profile-cuda',
    environment: { identity: 'environment-1', generation: 'environment-generation-1' },
    backend: { subject: 'backend-1', generation: 'backend-generation-1' },
    session: { identity: 'session-1', generation: 'session-generation-1' },
  };
}

function observeFrame() {
  const request = {
    protocol: ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
    requestId: 'request-1',
    executionId: 'execution-1',
    binding: binding(),
    api: 'cuda',
    topology: 'host-retained',
    operation: 'cuda.canary.u32-add-v1',
    input: { left: [1], right: [2] },
  };
  return encodeAcceleratorBrokerServiceRequestFrame({
    protocol: ACCELERATOR_BROKER_SERVICE_PROTOCOL,
    kind: ACCELERATOR_BROKER_SERVICE_KIND.OBSERVE,
    body: request,
  });
}

function endpoint(calls) {
  return new WindowsHyperVAcceleratorBrokerEndpoint({
    vmId: VM_ID.toUpperCase(),
    binding: binding(),
    service: new AcceleratorBrokerService({
      broker: {
        async execute() { calls.push('execute'); throw new Error('unexpected execute'); },
        async observe() { calls.push('observe'); return null; },
        async cancel() { calls.push('cancel'); return null; },
      },
    }),
  });
}

test('Hyper-V endpoint derives one fixed VSOCK-template service identity from the DevBridge service port', () => {
  const calls = [];
  const selected = endpoint(calls);
  assert.equal(windowsHyperVAcceleratorBrokerServiceId(), '0000d6dd-facb-11e6-bd58-64006a7986d3');
  assert.deepEqual(selected.descriptor(), {
    protocol: WINDOWS_HYPERV_ACCELERATOR_BROKER_ENDPOINT_PROTOCOL,
    platform: 'win32',
    family: 'AF_HYPERV',
    vmId: VM_ID,
    serviceId: '0000d6dd-facb-11e6-bd58-64006a7986d3',
    guestFamily: 'AF_VSOCK',
    hostCid: 2,
    port: ACCELERATOR_BROKER_VM_SERVICE_PORT,
  });
  assert.deepEqual(calls, []);
});

test('Hyper-V endpoint admits only the exact kernel-observed VM and service identities', async () => {
  const calls = [];
  const selected = endpoint(calls);
  const descriptor = selected.descriptor();
  const responseFrame = await selected.handleConnection({
    vmId: descriptor.vmId,
    serviceId: descriptor.serviceId,
    frame: observeFrame(),
  });
  const response = decodeAcceleratorBrokerServiceResponseFrame(responseFrame);
  assert.equal(response.outcome, ACCELERATOR_BROKER_SERVICE_OUTCOME.ABSENT);
  assert.deepEqual(calls, ['observe']);
});

test('wrong Hyper-V VM or service identity is rejected before broker invocation', async () => {
  for (const mismatch of [
    { vmId: OTHER_VM_ID, serviceId: windowsHyperVAcceleratorBrokerServiceId() },
    { vmId: VM_ID, serviceId: '0000d6de-facb-11e6-bd58-64006a7986d3' },
  ]) {
    const calls = [];
    const selected = endpoint(calls);
    await assert.rejects(
      selected.handleConnection({ ...mismatch, frame: observeFrame() }),
      (error) => error?.message === 'Hyper-V accelerator broker endpoint is unavailable',
    );
    assert.deepEqual(calls, []);
  }
});

test('Hyper-V connection metadata is closed and cannot carry guest-selected attachment authority', async () => {
  const calls = [];
  const selected = endpoint(calls);
  const descriptor = selected.descriptor();
  await assert.rejects(
    selected.handleConnection({
      vmId: descriptor.vmId,
      serviceId: descriptor.serviceId,
      frame: observeFrame(),
      binding: binding(),
    }),
    (error) => error?.message === 'Hyper-V accelerator broker endpoint is unavailable',
  );
  assert.deepEqual(calls, []);
});
