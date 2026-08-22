import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentConstructionPreparation } from '../src/app/environment-construction-preparation.js';
import { executionProfileSubject } from '../src/app/execution-profile-routing.js';

function request() {
  const declaration = {
    profile: 'linux-development',
    guest: { family: 'ubuntu', generation: '24.04.4' },
    bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
    enrollment: { requirement: 'unique-guest-trust-v1' },
  };
  return { declaration, bootstrap: declaration.bootstrap, enrollment: declaration.enrollment, implementationGeneration: 'env-0123456789abcdef0123456789abcdef' };
}

test('construction preparation binds access and bootstrap policy to the declared profile', async () => {
  const events = [];
  const connection = Object.freeze({ family: 'linux', user: 'devbridge', identityFile: 'identity', knownHostsFile: 'known-hosts' });
  const port = createEnvironmentConstructionPreparation({
    stateDirectory: '/state',
    platform: 'win32',
    invoke: async () => { throw new Error('unexpected invocation'); },
    createAccess: async ({ guest, platform }) => {
      events.push(['access', guest.family, platform]);
      return { connection: async (target) => ({ ...connection, target }), prepare: async () => ({ ready: true }) };
    },
    createBootstrap: async (input) => {
      events.push(['bootstrap', input.revision, [...input.requirements]]);
      return {
        ensure: async (target) => { events.push(['ensure', target]); return { ready: true }; },
        inspect: async (target) => { events.push(['inspect', target]); return { ready: true }; },
      };
    },
  });
  const selected = request();
  assert.deepEqual(await port.ensure(selected), { ready: true, implementationGeneration: selected.implementationGeneration });
  assert.deepEqual(await port.inspect(selected), { ready: true, enrollment: 'ready', bootstrap: 'ready', reason: null });
  assert.deepEqual(await port.access(selected), { ...connection, target: executionProfileSubject(selected.declaration.profile) });
  assert.deepEqual(events.slice(0, 3), [
    ['access', 'ubuntu', 'win32'],
    ['bootstrap', 'tooling-v1', ['runtime-js']],
    ['ensure', executionProfileSubject('linux-development')],
  ]);
});

test('construction preparation refuses enrollment drift and unsupported enrollment', async () => {
  const port = createEnvironmentConstructionPreparation({
    stateDirectory: '/state',
    createAccess: async () => ({ connection: async () => ({ family: 'linux' }), prepare: null }),
    createBootstrap: async () => ({ ensure: async () => ({ ready: true }), inspect: async () => ({ ready: true }) }),
  });
  const selected = request();
  await assert.rejects(() => port.ensure({ ...selected, enrollment: { requirement: 'other-v1' } }), /no longer matches/u);
  const changed = request();
  changed.declaration.enrollment = { requirement: 'other-v1' };
  changed.enrollment = changed.declaration.enrollment;
  await assert.rejects(() => port.ensure(changed), /unsupported/u);
});
