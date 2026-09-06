import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LibvirtVsockAcceleratorBrokerEndpoint,
  LIBVIRT_VSOCK_ACCELERATOR_BROKER_ENDPOINT_PROTOCOL,
  VSOCK_HOST_CID,
} from '../src/runtime/providers/libvirt-vsock-accelerator-broker-endpoint.js';
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

const GUEST_CID = 41;

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
  return new LibvirtVsockAcceleratorBrokerEndpoint({
    guestCid: GUEST_CID,
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

test('libvirt endpoint uses the fixed host VSOCK CID and DevBridge service port', () => {
  const calls = [];
  const selected = endpoint(calls);
  assert.deepEqual(selected.descriptor(), {
    protocol: LIBVIRT_VSOCK_ACCELERATOR_BROKER_ENDPOINT_PROTOCOL,
    platform: 'linux',
    family: 'AF_VSOCK',
    hostCid: VSOCK_HOST_CID,
    guestCid: GUEST_CID,
    port: ACCELERATOR_BROKER_VM_SERVICE_PORT,
  });
  assert.equal(VSOCK_HOST_CID, 2);
  assert.deepEqual(calls, []);
});

test('libvirt endpoint admits only the exact kernel-observed guest CID and local port', async () => {
  const calls = [];
  const selected = endpoint(calls);
  const responseFrame = await selected.handleConnection({
    peerCid: GUEST_CID,
    localPort: ACCELERATOR_BROKER_VM_SERVICE_PORT,
    frame: observeFrame(),
  });
  const response = decodeAcceleratorBrokerServiceResponseFrame(responseFrame);
  assert.equal(response.outcome, ACCELERATOR_BROKER_SERVICE_OUTCOME.ABSENT);
  assert.deepEqual(calls, ['observe']);
});

test('wrong libvirt guest CID or local service port is rejected before broker invocation', async () => {
  for (const mismatch of [
    { peerCid: GUEST_CID + 1, localPort: ACCELERATOR_BROKER_VM_SERVICE_PORT },
    { peerCid: GUEST_CID, localPort: ACCELERATOR_BROKER_VM_SERVICE_PORT + 1 },
  ]) {
    const calls = [];
    const selected = endpoint(calls);
    await assert.rejects(
      selected.handleConnection({ ...mismatch, frame: observeFrame() }),
      (error) => error?.message === 'libvirt accelerator broker endpoint is unavailable',
    );
    assert.deepEqual(calls, []);
  }
});

test('reserved or wildcard VSOCK CIDs cannot become trusted guest attachment identities', () => {
  for (const cid of [0, 1, 2, 0xffff_ffff, -1]) {
    assert.throws(
      () => new LibvirtVsockAcceleratorBrokerEndpoint({
        guestCid: cid,
        binding: binding(),
        service: new AcceleratorBrokerService({
          broker: { async execute() {}, async observe() {}, async cancel() {} },
        }),
      }),
      /guest CID is invalid/u,
    );
  }
});

test('libvirt connection metadata is closed and cannot carry guest-selected attachment authority', async () => {
  const calls = [];
  const selected = endpoint(calls);
  await assert.rejects(
    selected.handleConnection({
      peerCid: GUEST_CID,
      localPort: ACCELERATOR_BROKER_VM_SERVICE_PORT,
      frame: observeFrame(),
      profile: 'guest-selected',
    }),
    (error) => error?.message === 'libvirt accelerator broker endpoint is unavailable',
  );
  assert.deepEqual(calls, []);
});
