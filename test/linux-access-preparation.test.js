import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxAccessPreparation } from '../src/app/linux-access-preparation.js';

const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const connection = { family: 'linux', user: 'devbridge', identityFile: '/host/id', knownHostsFile: '/host/known' };
const resolved = { ...connection, address: '192.0.2.15' };

test('Linux access preparation is a no-op when strict access already verifies', async () => {
  let prepared = 0;
  let delivered = 0;
  const access = createLinuxAccessPreparation({
    material: { connection: () => connection, prepare: async () => { prepared += 1; } },
    delivery: { put: async () => { delivered += 1; } },
    probe: { inspect: async () => ({ ready: true }) },
  });
  assert.deepEqual(await access.ensure({ target, access: resolved }), { ready: true, changed: false });
  assert.equal(prepared, 0);
  assert.equal(delivered, 0);
});

test('Linux access preparation delivers one seed then requires strict probe readiness', async () => {
  const events = [];
  let probes = 0;
  const access = createLinuxAccessPreparation({
    material: {
      connection: () => connection,
      prepare: async () => ({ seedFile: '/owned/seed', connection, cleanup: async () => { events.push('cleanup'); } }),
    },
    delivery: { put: async (receivedTarget, source, destination) => { events.push(['deliver', receivedTarget, source, destination]); } },
    probe: { inspect: async () => { probes += 1; return { ready: probes >= 3, reason: 'starting' }; } },
    settleMs: 1000,
    pollMs: 1,
  });
  assert.deepEqual(await access.ensure({ target, access: resolved }), { ready: true, changed: true });
  assert.deepEqual(events[0], ['deliver', target, '/owned/seed', '/var/lib/devbridge/access/seed.json']);
  assert.equal(events.at(-1), 'cleanup');
});

test('Linux access preparation rejects a connection identity that changed under it', async () => {
  const access = createLinuxAccessPreparation({
    material: { connection: () => connection, prepare: async () => { throw new Error('unused'); } },
    delivery: { put: async () => {} },
    probe: { inspect: async () => ({ ready: false }) },
  });
  await assert.rejects(() => access.ensure({ target, access: { ...resolved, identityFile: '/other' } }), /connection changed/u);
});

test('first access allows observed two-minute guest startup with one delivery', async () => {
  let clock = 0;
  let deliveries = 0;
  let cleaned = 0;
  const access = createLinuxAccessPreparation({
    material: { connection: () => connection, prepare: async () => ({ seedFile: '/owned/seed', connection, cleanup: async () => { cleaned++; } }) },
    delivery: { put: async () => { deliveries++; } },
    probe: { inspect: async () => ({ ready: clock >= 125_000, reason: 'waiting for SSH banner' }) },
    now: () => clock,
    wait: async (ms) => { clock += ms; },
  });
  assert.deepEqual(await access.ensure({ target, access: resolved }), { ready: true, changed: true });
  assert.equal(deliveries, 1);
  assert.equal(cleaned, 1);
  assert.equal(clock, 125_000);
  assert.deepEqual(await access.ensure({ target, access: resolved }), { ready: true, changed: false });
  assert.equal(deliveries, 1);
});

test('first access respects enclosing deadline and cancellation and always cleans staging', async () => {
  for (const cancel of [false, true]) {
    let clock = 0;
    let cleaned = 0;
    let deliveries = 0;
    const controller = new AbortController();
    const access = createLinuxAccessPreparation({
      material: { connection: () => connection, prepare: async () => ({ seedFile: '/owned/seed', connection, cleanup: async () => { cleaned++; } }) },
      delivery: { put: async (_target, _source, _destination, options) => { deliveries++; assert.equal(options.signal, controller.signal); assert.ok(options.timeoutMs <= 2_000 - clock); } },
      probe: { inspect: async (_access, options) => {
        assert.equal(options.signal, controller.signal);
        assert.ok(options.timeoutMs <= 2_000 - clock);
        return { ready: false, reason: 'waiting for SSH banner' };
      } },
      now: () => clock,
      wait: async (ms) => { clock += ms; if (cancel) controller.abort(new Error('lease lost')); },
    });
    await assert.rejects(access.ensure({ target, access: resolved, deadline: 2_000, signal: controller.signal }), cancel ? /lease lost/u : /deadline: waiting for SSH banner/u);
    assert.equal(deliveries, 1);
    assert.equal(cleaned, 1);
    assert.ok(clock <= 2_000);
  }
});
