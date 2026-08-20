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
      assert.equal(payload.destination, '/var/lib/devbridge/bootstrap/network-seed.json');
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
