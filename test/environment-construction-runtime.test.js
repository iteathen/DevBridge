import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentConstructionRuntime } from '../src/app/environment-construction-runtime.js';

function foundation() {
  return {
    inspect: async () => ({ capabilities: { management: { ready: true }, storage: { ready: true }, networking: { ready: true } } }),
    ensureStorage: async () => ({ ready: true }),
    ensureNetwork: async () => ({ ready: true }),
    reconcile: async () => ({ ready: true }),
    listEnvironments: async () => [],
    observeEnvironment: async () => null,
    ensureEnvironment: async () => { throw new Error('not expected during composition'); },
    rebuildEnvironment: async () => { throw new Error('not expected during composition'); },
    recreateEnvironment: async () => { throw new Error('not expected during composition'); },
    retireSupersededEnvironment: async () => { throw new Error('not expected during composition'); },
  };
}

test('production construction composition exposes shared create, diagnosis, repair, rebuild, and recreate lifecycles without materializing on construction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-construction-runtime-'));
  try {
    const runtime = await createEnvironmentConstructionRuntime({
      stateDirectory: directory,
      availability: { ensure: async () => ({ state: 'local' }) },
      resolveAuthority: async () => '42',
      foundation: foundation(),
      fence: { acquire: async ({ subject }) => ({ subject, release: async () => {} }) },
      invoke: async () => { throw new Error('not expected during composition'); },
    });
    assert.equal(typeof runtime.create, 'function');
    assert.equal(typeof runtime.pipeline.run, 'function');
    assert.equal(typeof runtime.lifecycle.declarations.register, 'function');
    assert.equal(typeof runtime.observer.observe, 'function');
    assert.equal(typeof runtime.diagnose, 'function');
    assert.equal(typeof runtime.diagnosis.list, 'function');
    assert.equal(typeof runtime.repair, 'function');
    assert.equal(typeof runtime.planRebuild, 'function');
    assert.equal(typeof runtime.rebuild, 'function');
    assert.equal(typeof runtime.planRecreate, 'function');
    assert.equal(typeof runtime.recreate, 'function');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
