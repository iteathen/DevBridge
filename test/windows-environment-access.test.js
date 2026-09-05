import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWindowsEnvironmentAccess } from '../src/app/windows-environment-access.js';

const identity = 'e'.repeat(32);

test('Windows environment access composes replaceable local ports under protected authority state', async () => {
  const captured = {};
  const material = { kind: 'material' };
  const seed = { kind: 'seed' };
  const delivery = { kind: 'delivery' };
  const probe = { kind: 'probe' };
  const prepared = {
    connection: async (target) => ({ connection: target }),
    ensure: async (request) => ({ prepared: request }),
  };
  const authorityDirectory = path.resolve('C:\\protected-state');
  const access = await createWindowsEnvironmentAccess({
    authorityDirectory,
    platform: 'win32',
    invoke: async () => {},
    identityLoader: async (options) => { captured.identity = options; return identity; },
    materialFactory: (options) => { captured.material = options; return material; },
    seedFactory: (options) => { captured.seed = options; return seed; },
    deliveryFactory: (options) => { captured.delivery = options; return delivery; },
    probeFactory: (options) => { captured.probe = options; return probe; },
    preparationFactory: (options) => { captured.preparation = options; return prepared; },
  });
  assert.deepEqual(await access.connection('target'), { connection: 'target' });
  assert.deepEqual(await access.prepare({ target: 'target' }), { prepared: { target: 'target' } });
  const root = path.join(authorityDirectory, 'environment-foundation');
  assert.equal(captured.identity.directory, root);
  assert.equal(captured.material.directory, path.join(root, 'access', 'windows', 'material'));
  assert.equal(captured.material.user, 'devbridge');
  assert.equal(captured.seed.directory, path.join(root, 'access', 'windows', 'transient'));
  assert.equal(captured.seed.user, 'devbridge');
  assert.deepEqual(captured.delivery, { identity, invoke: captured.material.invoke });
  assert.deepEqual(captured.probe, { identity, invoke: captured.material.invoke });
  assert.deepEqual(captured.preparation, { material, seed, delivery, probe });
});

test('Windows environment access fails closed on another host before creating authority state', async () => {
  let loaded = false;
  await assert.rejects(() => createWindowsEnvironmentAccess({
    authorityDirectory: path.resolve('state'),
    platform: 'linux',
    invoke: async () => {},
    identityLoader: async () => { loaded = true; },
  }), /unavailable on this host/u);
  assert.equal(loaded, false);
});
