import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentConstructionRuntime } from '../src/app/environment-construction-runtime.js';
import { createEnvironmentConstructionPreparation } from '../src/app/environment-construction-preparation.js';
import { executionProfileSubject, executionWorkspaceIdentity } from '../src/app/execution-profile-routing.js';
import { logicalEnvironmentIdentity } from '../src/runtime/environment-declaration.js';

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

for (const family of ['ubuntu', 'windows-11']) test(`workspace composition uses the protected foundation and real ${family} preparation contract`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspace-composition-'));
  try {
    const ordinary = path.join(directory, 'ordinary');
    const authority = path.join(directory, 'protected');
    const profile = family === 'ubuntu' ? 'linux-development' : 'windows-development';
    const target = 'env-0123456789abcdef0123456789abcdef';
    const declaration = {
      profile, guest: { family, generation: 'guest-v1' },
      image: { identity: 'image-v1', generation: 'image-v1' },
      bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
      enrollment: { requirement: 'unique-guest-trust-v1' },
      workspaces: [{ identity: executionWorkspaceIdentity('42', profile), authority: '42' }],
    };
    const state = foundation();
    const physical = {
      record: { identity: target, profile, subject: executionProfileSubject(profile) },
      observation: { owned: true, exists: true, compatible: true, storageState: 'present', storage: { sourceIdentity: 'image-v1' } },
    };
    state.listEnvironments = async () => [physical];
    state.observeEnvironment = async () => physical;
    const connections = [];
    const runtime = await createEnvironmentConstructionRuntime({
      stateDirectory: ordinary, authorityDirectory: authority,
      foundation: state, availability: { ensure: async () => ({ state: 'local' }) },
      routeState: { load: async () => null, publish: async () => { throw new Error('observation cannot publish routes'); } },
      resolveAuthority: async value => value,
      fence: { acquire: async ({ subject }) => ({ subject, release: async () => {} }) },
      invoke: async () => { throw new Error('observation cannot perform native mutations'); },
    }, {
      preparationFactory: options => createEnvironmentConstructionPreparation({
        ...options,
        createAccess: async () => ({ connection: async selected => ({ target: selected }) }),
        createBootstrap: async () => ({
          ensure: async () => { throw new Error('observation cannot bootstrap'); },
          inspect: async () => ({ ready: true, network: { nameResolution: true, secureWeb: true } }),
          connection: async selected => { connections.push(selected); return { target: selected }; },
        }),
      }),
      bridgeFactory: async options => {
        assert.equal(options.stateDirectory, authority, 'provider identity must come from the effect-owning foundation');
        return {
          health: async selected => { assert.deepEqual(await options.access(selected), { target }); return { ready: true }; },
          execute() {}, put() {}, get() {},
        };
      },
    });
    const observed = await runtime.observer.observe({ environmentIdentity: logicalEnvironmentIdentity(profile), declarationRevision: 1, declaration });
    assert.equal(observed.guest, 'healthy');
    assert.equal(observed.implementationGeneration, target);
    assert.deepEqual(connections, [target]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
