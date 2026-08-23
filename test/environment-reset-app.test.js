import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentResetMaterialization, createEnvironmentResetRetirement } from '../src/app/environment-reset.js';

const OLD = `env-${'1'.repeat(32)}`;
const NEXT = `env-${'2'.repeat(32)}`;
const IMAGE = 'image-ubuntu-v1';
const AUTH = `reset-${'a'.repeat(64)}`;

function request() {
  return {
    environmentIdentity: 'logical-environment-a',
    operationId: 'lifecycle-reset-1',
    declarationRevision: 1,
    declaration: { profile: 'linux-development', image: { identity: IMAGE } },
  };
}

function activeJournal(stage = 'fenced-attempt') {
  const entries = [
    { stage: 'intent', implementationGeneration: null },
    { stage: 'pre-observation', implementationGeneration: OLD, subjects: [AUTH] },
    { stage: 'fenced-attempt', implementationGeneration: OLD, subjects: [AUTH] },
  ];
  if (['post-observation', 'verification'].includes(stage)) entries.push({ stage: 'post-observation', implementationGeneration: NEXT, subjects: [AUTH] });
  if (stage === 'verification') entries.push({ stage: 'verification', implementationGeneration: NEXT, subjects: [AUTH] });
  return { operation: 'reset', operationId: 'lifecycle-reset-1', declarationRevision: 1, entries };
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

test('reset retirement can target only the exact previous generation after verified outer lifecycle state', async () => {
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
    journal: { current: async () => activeJournal('verification') },
  });
  const result = await retirement.ensure({
    environmentIdentity: 'logical-environment-a',
    operationId: 'lifecycle-reset-1',
    declarationRevision: 1,
    previousImplementationGeneration: OLD,
    implementationGeneration: NEXT,
    authorizationSubject: AUTH,
  });
  assert.deepEqual(result, { ready: true, identity: OLD, removed: true, absent: false });
  assert.equal(calls, 1);
});

test('reset retirement refuses pre-verification, generation drift, or changed authorization subject before deletion', async () => {
  let calls = 0;
  const state = { async retireSupersededEnvironment() { calls += 1; return { identity: OLD, removed: true }; } };
  const input = {
    environmentIdentity: 'logical-environment-a', operationId: 'lifecycle-reset-1', declarationRevision: 1,
    previousImplementationGeneration: OLD, implementationGeneration: NEXT, authorizationSubject: AUTH,
  };
  let journalState = activeJournal('post-observation');
  const retirement = createEnvironmentResetRetirement({ state, journal: { current: async () => journalState } });
  await assert.rejects(() => retirement.ensure(input), /verified active reset lifecycle/u);
  assert.equal(calls, 0);

  journalState = activeJournal('verification');
  journalState.entries.at(-1).implementationGeneration = `env-${'3'.repeat(32)}`;
  await assert.rejects(() => retirement.ensure(input), /generation evidence changed/u);
  assert.equal(calls, 0);

  journalState = activeJournal('verification');
  journalState.entries.at(-1).subjects = [`reset-${'b'.repeat(64)}`];
  await assert.rejects(() => retirement.ensure(input), /authorization subject changed/u);
  assert.equal(calls, 0);
});
