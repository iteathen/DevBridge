import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HyperVEnvironmentBootstrap } from '../src/runtime/providers/hyperv-environment-bootstrap.js';

const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const other = 'env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function success(stdout) {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr: '' };
}

function location(value) {
  return {
    reference: `machine-${value.slice(-8)}`,
    proof: `owned:${value}`,
    family: 'linux',
    network: { reference: 'network-local', proof: 'owned:network', prefix: '192.168.90.0/24', gateway: '192.168.90.1' },
  };
}

const baseConnection = { family: 'linux', user: 'guest', identityFile: '/keys/id', knownHostsFile: '/keys/known' };

test('Hyper-V preparation uses only located ownership/network state and activation copies a bounded seed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hv-bootstrap-'));
  let copies = 0;
  let copiedSeed = null;
  const invoke = async (request) => {
    assert.equal(request.executable, 'powershell.exe');
    const payload = JSON.parse(request.input);
    if (payload.networkReference) {
      assert.equal(payload.reference, location(target).reference);
      assert.equal(payload.proof, location(target).proof);
      assert.equal(payload.networkReference, 'network-local');
      return success(JSON.stringify({ ready: true, state: 'off' }));
    }
    if (payload.source) {
      copies += 1;
      copiedSeed = JSON.parse(await readFile(payload.source, 'utf8'));
      assert.equal(payload.destination, '/var/lib/devbridge/bootstrap');
      assert.equal(path.basename(payload.source), 'network-seed.json');
      return success(JSON.stringify({ copied: true }));
    }
    throw new Error('unexpected management request');
  };
  try {
    const adapter = new HyperVEnvironmentBootstrap({
      directory: root,
      invoke,
      locate: async (value) => location(value),
      connection: async () => baseConnection,
      dnsServers: () => ['10.0.0.53'],
    });
    assert.deepEqual(await adapter.prepare(target), { ready: true, cycleRequired: false });
    const activated = await adapter.activate(target);
    assert.equal(activated.ready, true);
    assert.equal(copies, 1);
    assert.equal(copiedSeed.protocol, 'devbridge/network-seed-v1');
    assert.equal(copiedSeed.target, target);
    assert.equal(copiedSeed.gateway, '192.168.90.1');
    assert.deepEqual(copiedSeed.dns, ['10.0.0.53']);
    assert.match(copiedSeed.address, /^192\.168\.90\.(?:1\d|2\d|[3-9]\d|1\d\d|2[0-4]\d|250)$/u);
    const connected = await adapter.connection(target);
    assert.equal(connected.family, 'linux');
    assert.equal(connected.user, 'guest');
    assert.equal(connected.address, copiedSeed.address);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Hyper-V address allocation is durable, collision-free within retained targets, and reclaimable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hv-address-'));
  const options = {
    directory: root,
    invoke: async () => success(JSON.stringify({ ready: true })),
    locate: async (value) => location(value),
    connection: async () => baseConnection,
    dnsServers: () => ['1.1.1.1'],
  };
  try {
    const first = new HyperVEnvironmentBootstrap(options);
    const a1 = (await first.connection(target)).address;
    const b1 = (await first.connection(other)).address;
    assert.notEqual(a1, b1);
    const second = new HyperVEnvironmentBootstrap(options);
    assert.equal((await second.connection(target)).address, a1);
    assert.equal((await second.connection(other)).address, b1);
    const reconciled = await second.reconcile([target]);
    assert.equal(reconciled.changed, true);
    assert.equal(reconciled.retained, 1);
    const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    assert.deepEqual(Object.keys(state.allocations), [target]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Hyper-V activation resets the exact owned guest file service once after a failed copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hv-bootstrap-reset-'));
  let copies = 0;
  let resets = 0;
  const invoke = async (request) => {
    const payload = JSON.parse(request.input);
    if (payload.source) {
      copies += 1;
      if (copies === 1) return { ...success(''), exitCode: 1, stderr: 'guest service channel unavailable' };
      const seed = JSON.parse(await readFile(payload.source, 'utf8'));
      assert.deepEqual(seed.dns, ['1.1.1.1']);
      return success(JSON.stringify({ copied: true }));
    }
    if (payload.resetService === true) {
      resets += 1;
      assert.equal(payload.reference, location(target).reference);
      assert.equal(payload.proof, location(target).proof);
      return success(JSON.stringify({ reset: true }));
    }
    throw new Error('unexpected management request');
  };
  try {
    const adapter = new HyperVEnvironmentBootstrap({
      directory: root,
      invoke,
      locate: async (value) => location(value),
      connection: async () => baseConnection,
      dnsServers: () => ['127.0.0.1', '169.254.10.20'],
    });
    assert.deepEqual(await adapter.activate(target), { ready: true, address: (await adapter.connection(target)).address });
    assert.equal(copies, 2);
    assert.equal(resets, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Hyper-V activation requests one lifecycle-owned cycle after bounded copy recovery is exhausted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hv-bootstrap-cycle-'));
  let now = 0;
  let copies = 0;
  let resets = 0;
  const invoke = async (request) => {
    const payload = JSON.parse(request.input);
    if (payload.source) {
      copies += 1;
      return { ...success(''), exitCode: 1, stderr: 'guest service channel unavailable' };
    }
    if (payload.resetService === true) {
      resets += 1;
      return success(JSON.stringify({ reset: true }));
    }
    throw new Error('unexpected management request');
  };
  try {
    const adapter = new HyperVEnvironmentBootstrap({
      directory: root,
      invoke,
      locate: async (value) => location(value),
      connection: async () => baseConnection,
      dnsServers: () => ['10.0.0.53'],
      now: () => now,
      delay: async (ms) => { now += ms; },
      copySettleMs: 2_000,
    });
    const activated = await adapter.activate(target);
    assert.equal(activated.ready, false);
    assert.equal(activated.cycleRequired, true);
    assert.equal(copies, 2);
    assert.equal(resets, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('separate bootstrap instances cannot overlap allocation mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hv-address-exclusive-'));
  const options = {
    directory: root,
    invoke: async () => success(JSON.stringify({ ready: true })),
    locate: async (value) => location(value),
    connection: async () => baseConnection,
    dnsServers: () => ['1.1.1.1'],
  };
  try {
    const first = new HyperVEnvironmentBootstrap(options);
    const second = new HyperVEnvironmentBootstrap(options);
    const results = await Promise.allSettled([first.connection(target), second.connection(other)]);
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(results.filter((entry) => entry.status === 'rejected').length, 1);
    assert.match(results.find((entry) => entry.status === 'rejected').reason.message, /allocation mutation is already active/u);
    const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    assert.equal(Object.keys(state.allocations).length, 1);
    const firstAddress = (await first.connection(target)).address;
    const secondAddress = (await second.connection(other)).address;
    assert.notEqual(firstAddress, secondAddress);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
