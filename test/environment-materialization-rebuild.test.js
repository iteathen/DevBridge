import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentMaterialization, createEnvironmentRebuildMaterialization } from '../src/app/environment-materialization.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL, environmentObservationCondition } from '../src/runtime/environment-observation.js';

const CURRENT = `env-${'1'.repeat(32)}`;
const NEXT = `env-${'2'.repeat(32)}`;
const declaration = {
  profile: 'linux-development',
  image: { identity: 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', generation: 'ubuntu-v1' },
  resources: { memoryBytes: 4096, processorCount: 4 },
  boot: { requirement: 'efi-v1' },
};
function request() {
  return { environmentIdentity: 'environment-0123456789abcdef0123456789abcdef', operationId: 'lifecycle-rebuild-1', declarationRevision: 1, declaration };
}
function subject() { return { resolve: async () => 'profile-subject-1' }; }
function settings() { return { resolve: async () => ({ memoryBytes: 4096, processorCount: 4, firmware: 'efi' }) }; }

test('materialization projects neutral missing and invalid storage evidence into rebuild diagnoses', async () => {
  let storageState = 'absent';
  const state = {
    listEnvironments: async () => [{
      record: { identity: CURRENT, subject: 'profile-subject-1', profile: declaration.profile },
      observation: { identity: CURRENT, exists: true, owned: true, compatible: false, state: 'off', storage: null, storageState },
    }],
    ensureEnvironment: async () => { throw new Error('unused'); },
  };
  const materialization = createEnvironmentMaterialization({ state, subject: subject(), settings: settings() });
  const missing = await materialization.observe(request());
  assert.equal(missing.protocol, ENVIRONMENT_OBSERVATION_PROTOCOL);
  assert.equal(missing.systemStorage, 'absent');
  assert.equal(environmentObservationCondition(missing), 'system-storage-missing');
  storageState = 'invalid';
  const invalid = await materialization.observe(request());
  assert.equal(invalid.systemStorage, 'invalid');
  assert.equal(environmentObservationCondition(invalid), 'system-storage-invalid');
});

test('rebuild materialization binds replacement to active outer lifecycle and previous generation', async () => {
  let supplied = null;
  const state = {
    listEnvironments: async () => [{ record: { identity: CURRENT, subject: 'profile-subject-1', profile: declaration.profile, source: { identity: declaration.image.identity } }, observation: {} }],
    rebuildEnvironment: async (identity, options) => {
      supplied = { identity, options };
      return {
        record: { identity: NEXT },
        observation: { exists: true, owned: true, compatible: true },
        superseded: { identity: CURRENT, cleanup: 'retained' },
      };
    },
  };
  const journal = {
    current: async () => ({
      operation: 'rebuild', operationId: 'lifecycle-rebuild-1', declarationRevision: 1,
      entries: [{ stage: 'intent' }, { stage: 'pre-observation', implementationGeneration: CURRENT }],
    }),
  };
  const materialization = createEnvironmentRebuildMaterialization({ state, subject: subject(), journal });
  const result = await materialization.ensure(request());
  assert.equal(result.ready, true);
  assert.equal(result.implementationGeneration, NEXT);
  assert.deepEqual(result.superseded, { identity: CURRENT, cleanup: 'retained' });
  assert.deepEqual(supplied, {
    identity: CURRENT,
    options: { requestId: 'lifecycle-rebuild-1', expectedPreviousIdentity: CURRENT },
  });
});

test('rebuild materialization refuses source or lifecycle authority drift', async () => {
  const state = {
    listEnvironments: async () => [{ record: { identity: CURRENT, subject: 'profile-subject-1', profile: declaration.profile, source: { identity: 'img-other' } }, observation: {} }],
    rebuildEnvironment: async () => { throw new Error('unused'); },
  };
  const materialization = createEnvironmentRebuildMaterialization({
    state, subject: subject(), journal: { current: async () => null },
  });
  await assert.rejects(() => materialization.ensure(request()), /source no longer matches/u);
});
