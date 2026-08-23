import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentResetMaterialization, createEnvironmentResetRetirement } from '../src/app/environment-reset.js';

const OLD = `env-${'1'.repeat(32)}`;
const NEXT = `env-${'2'.repeat(32)}`;
const IMAGE = 'image-ubuntu-v1';

function request() {
  return {
    environmentIdentity: 'logical-environment-a',
    operationId: 'lifecycle-reset-1',
    declarationRevision: 1,
    declaration: { profile: 'linux-development', image: { identity: IMAGE } },
  };
}

function activeJournal() {
  return {
    operation: 'reset', operationId: 'lifecycle-reset-1', declarationRevision: 1,
    entries: [
      { stage: 'intent', implementationGeneration: null },
      { stage: 'pre-observation', implementationGeneration: OLD },
      { stage: 'fenced-attempt', implementationGeneration: OLD },
    ],
  };
}

test('reset materialization binds staged replacement to the active outer lifecycle and retains the old generation', async () => {
  let current = OLD;
  let calls = 0;
  const state = {
    async listEnvironments() {
      return [{ record: { identity: current, subject: 'profile-subject', profile: 'linux-development', source: { identity: IMAGE } }, observation: {} }];
    },
    async replaceEnvironment(identity, options) {
      calls += 1;
      assert.equal(identity, current);
      assert.deepEqual(options, { requestId: 'lifecycle-reset-1', expectedPreviousIdentity: OLD });
      current = NEXT;
      return {
        record: { identity: NEXT },
        observation: { exists: true, owned: true, compatible: true },
        superseded: { identity: OLD, cleanup: 'retained' },
      };
    },
  };
  const materialization = createEnvironmentResetMaterialization({
    state,
    subject: { resolve: async () => 'profile-subject' },
    journal: { current: async () => activeJournal() },
  });
  const result = await materialization.ensure(request());
  assert.equal(result.ready, true);
  assert.equal(result.implementationGeneration, NEXT);
  assert.deepEqual(result.superseded, { identity: OLD, cleanup: 'retained' });
  assert.equal(calls, 1);
});

test('reset materialization refuses a replacement not bound to the exact reset lifecycle', async () => {
  let calls = 0;
  const materialization = createEnvironmentResetMaterialization({
    state: {
      async listEnvironments() { return [{ record: { identity: OLD, subject: 'profile-subject', profile: 'linux-development', source: { identity: IMAGE } }, observation: {} }]; },
      async replaceEnvironment() { calls += 1; throw new Error('unused'); },
    },
    subject: { resolve: async () => 'profile-subject' },
    journal: { current: async () => ({ ...activeJournal(), operation: 'rebuild' }) },
  });
  await assert.rejects(() => materialization.ensure(request()), /active reset lifecycle/u);
  assert.equal(calls, 0);
});

test('reset retirement can target only the exact previous generation after verification', async () => {
  let calls = 0;
  const retirement = createEnvironmentResetRetirement({
    state: {
      async retireSupersededEnvironment(identity, options) {
        calls += 1;
        assert.equal(identity, NEXT);
        assert.deepEqual(options, { supersededIdentity: OLD });
        return { identity: OLD, removed: true, absent: false };
      },
    },
  });
  const result = await retirement.ensure({
    environmentIdentity: 'logical-environment-a',
    operationId: 'lifecycle-reset-1',
    declarationRevision: 1,
    previousImplementationGeneration: OLD,
    implementationGeneration: NEXT,
    authorizationSubject: `reset-${'a'.repeat(64)}`,
  });
  assert.deepEqual(result, { ready: true, identity: OLD, removed: true, absent: false });
  assert.equal(calls, 1);
});
