import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HyperVEnvironmentBootstrap } from '../src/runtime/providers/hyperv-environment-bootstrap.js';

const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const other = 'env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const reserved = 'subject-cccccccccccccccccccccccccccccccc';

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
      return success(JSON.stringify({ ready: true, state: 'off', cycleRequired: false }));
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

test('Hyper-V preparation requests one lifecycle cycle when a running guest file service has no contact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hv-bootstrap-cycle-'));
  let calls = 0;
  try {
    const adapter = new HyperVEnvironmentBootstrap({
      directory: root,
      invoke: async (request) => {
        calls += 1;
        const script = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
        assert.match(script, /PrimaryOperationalStatus/u);
        assert.match(script, /\$running -and -not \$contact/u);
        return success(JSON.stringify({ ready: true, state: 'running', cycleRequired: true }));
      },
      locate: async (value) => location(value),
      connection: async () => baseConnection,
      dnsServers: () => ['10.0.0.53'],
    });
    assert.deepEqual(await adapter.prepare(target), { ready: true, cycleRequired: true });
    assert.equal(calls, 1);
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

test('reserved addresses share the collision domain but survive managed-target reconciliation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hv-reserved-address-'));
  const options = {
    directory: root,
    invoke: async () => success(JSON.stringify({ ready: true })),
    locate: async (value) => location(value),
    connection: async () => baseConnection,
    dnsServers: () => ['10.0.0.53', 'not-an-ipv4'],
  };
  try {
    const adapter = new HyperVEnvironmentBootstrap(options);
    const lease = await adapter.reserveAddress(reserved, location(reserved).network);
    const managed = (await adapter.connection(target)).address;
    assert.notEqual(lease.address, managed);
    assert.equal(lease.prefixLength, 24);
    assert.equal(lease.gateway, '192.168.90.1');
    assert.deepEqual(lease.dns, ['10.0.0.53']);

    const reconciled = await adapter.reconcile([]);
    assert.equal(reconciled.changed, true);
    const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    assert.equal(state.allocations[reserved].scope, 'reserved');
    assert.equal(state.allocations[reserved].address, lease.address);
    assert.equal(state.allocations[target], undefined);

    assert.deepEqual(await adapter.releaseAddress(reserved), { changed: true, absent: false });
    assert.deepEqual(await adapter.releaseAddress(reserved), { changed: false, absent: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reserved addresses cannot silently adopt managed allocation ownership', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-hv-reserved-scope-'));
  const options = {
    directory: root,
    invoke: async () => success(JSON.stringify({ ready: true })),
    locate: async (value) => location(value),
    connection: async () => baseConnection,
    dnsServers: () => [],
  };
  try {
    const adapter = new HyperVEnvironmentBootstrap(options);
    await adapter.connection(target);
    await assert.rejects(() => adapter.reserveAddress(target, location(target).network), /scope changed/u);
    await assert.rejects(() => adapter.releaseAddress(target), /managed network allocation/u);
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
