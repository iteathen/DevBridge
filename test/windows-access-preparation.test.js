import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsAccessPreparation } from '../src/app/windows-access-preparation.js';

const target = `env-${'b'.repeat(32)}`;
const connection = Object.freeze({ family: 'windows', username: 'devbridge', password: 'Db!A9-private-access-value' });

function material() {
  return {
    ensure: async () => ({ identity: target, user: 'devbridge' }),
    resolve: async () => ({ user: 'devbridge', secret: connection.password }),
  };
}

test('Windows access preparation is a no-op when exact access already verifies', async () => {
  let created = 0;
  let delivered = 0;
  const preparation = createWindowsAccessPreparation({
    material: material(),
    seed: { create: async () => { created += 1; } },
    delivery: { put: async () => { delivered += 1; } },
    probe: { inspect: async () => ({ ready: true }) },
  });
  assert.deepEqual(await preparation.ensure({ target, access: connection }), { ready: true, changed: false });
  assert.equal(created, 0);
  assert.equal(delivered, 0);
});

test('Windows access preparation delivers one fixed seed and cleans it after bounded readiness', async () => {
  const events = [];
  let probes = 0;
  let clock = 0;
  const preparation = createWindowsAccessPreparation({
    material: material(),
    seed: {
      create: async (request) => {
        events.push(['seed', request]);
        return { file: 'C:\\owned\\seed.json', cleanup: async () => { events.push('cleanup'); } };
      },
    },
    delivery: { put: async (...values) => { events.push(['deliver', ...values]); } },
    probe: { inspect: async (request) => { events.push(['probe', request.target]); probes += 1; return { ready: probes >= 3, reason: 'starting' }; } },
    settleMs: 100,
    pollMs: 1,
    now: () => clock,
    wait: async (delay) => { clock += delay; },
  });
  assert.deepEqual(await preparation.ensure({ target, access: connection }), { ready: true, changed: true });
  assert.deepEqual(events.find((entry) => Array.isArray(entry) && entry[0] === 'seed'), ['seed', { target, user: 'devbridge', secret: connection.password }]);
  assert.deepEqual(events.find((entry) => Array.isArray(entry) && entry[0] === 'deliver'), ['deliver', target, 'C:\\owned\\seed.json', 'C:\\ProgramData\\DevBridge\\access\\seed.json']);
  assert.equal(events.at(-1), 'cleanup');
});

test('Windows access preparation rejects connection drift and cleans transient material on failure', async () => {
  let cleaned = 0;
  const preparation = createWindowsAccessPreparation({
    material: material(),
    seed: { create: async () => ({ file: 'C:\\owned\\seed.json', cleanup: async () => { cleaned += 1; } }) },
    delivery: { put: async () => { throw new Error('delivery unavailable'); } },
    probe: { inspect: async () => ({ ready: false, reason: 'not ready' }) },
  });
  await assert.rejects(() => preparation.ensure({ target, access: { ...connection, password: 'Db!A9-other-private-value' } }), /connection changed/u);
  await assert.rejects(() => preparation.ensure({ target, access: connection }), /delivery unavailable/u);
  assert.equal(cleaned, 1);
});

test('Windows access preparation times out without exposing its secret', async () => {
  let clock = 0;
  let cleaned = 0;
  const preparation = createWindowsAccessPreparation({
    material: material(),
    seed: { create: async () => ({ file: 'C:\\owned\\seed.json', cleanup: async () => { cleaned += 1; } }) },
    delivery: { put: async () => ({ delivered: true }) },
    probe: { inspect: async () => ({ ready: false, reason: `unavailable ${connection.password}` }) },
    settleMs: 1,
    pollMs: 1,
    now: () => clock,
    wait: async () => { clock += 1; },
  });
  await assert.rejects(
    () => preparation.ensure({ target, access: connection }),
    (error) => !error.message.includes(connection.password),
  );
  assert.equal(cleaned, 1);
});

test('Windows access preparation stays independent from provider and repository topology', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/app/windows-access-preparation.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /HyperV|libvirt|GitHub|repository[A-Z]|branch|pull request|Codex|CUDA/iu);
});
