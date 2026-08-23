import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentRecreateMaterialization, createEnvironmentRecreateRetirement } from '../src/app/environment-recreate.js';

const OLD = `env-${'1'.repeat(32)}`;
const NEXT = `env-${'2'.repeat(32)}`;
const IMAGE = 'image-ubuntu-v1';
const AUTHORIZATION = `recreate-${'a'.repeat(64)}`;

function request() {
  return {
    environmentIdentity: 'logical-environment-a',
    operationId: 'lifecycle-recreate-1',
    declarationRevision: 1,
    declaration: { profile: 'linux-development', image: { identity: IMAGE } },
  };
}
function activeJournal(stage = 'fenced-attempt') {
  const entries = [
    { stage: 'intent', implementationGeneration: null, subjects: [] },
    { stage: 'pre-observation', implementationGeneration: OLD, subjects: [AUTHORIZATION] },
    { stage: 'fenced-attempt', implementationGeneration: OLD, subjects: [AUTHORIZATION] },
  ];
  if (['post-observation', 'verification'].includes(stage)) entries.push({ stage: 'post-observation', implementationGeneration: NEXT, subjects: [AUTHORIZATION] });
  if (stage === 'verification') entries.push({ stage: 'verification', implementationGeneration: NEXT, subjects: [AUTHORIZATION] });
  return { operation: 'recreate', operationId: 'lifecycle-recreate-1', declarationRevision: 1, entries };
}

test('recreate materialization binds replacement to the active lifecycle and accepts a missing superseded provider', async () => {
  let calls = 0;
  const materialization = createEnvironmentRecreateMaterialization({
    state: {
      async listEnvironments() { return [{ record: { identity: OLD, subject: 'profile-subject', profile: 'linux-development', source: { identity: IMAGE } }, observation: { exists: false } }]; },
      async recreateEnvironment(identity, options) {
        calls += 1;
        assert.equal(identity, OLD);
        assert.deepEqual(options, { requestId: 'lifecycle-recreate-1', expectedPreviousIdentity: OLD });
        return {
          record: { identity: NEXT }, observation: { exists: true, owned: true, compatible: true },
          superseded: { identity: OLD, cleanup: 'absent' },
        };
      },
    },
    subject: { resolve: async () => 'profile-subject' },
    journal: { current: async () => activeJournal() },
  });
  const result = await materialization.ensure(request());
  assert.deepEqual(result, { ready: true, implementationGeneration: NEXT, superseded: { identity: OLD, cleanup: 'absent' } });
  assert.equal(calls, 1);
});

test('recreate materialization refuses provider effects not bound to the exact recreate lifecycle', async () => {
  let calls = 0;
  const materialization = createEnvironmentRecreateMaterialization({
    state: {
      async listEnvironments() { return [{ record: { identity: OLD, subject: 'profile-subject', profile: 'linux-development', source: { identity: IMAGE } }, observation: {} }]; },
      async recreateEnvironment() { calls += 1; throw new Error('unused'); },
    },
    subject: { resolve: async () => 'profile-subject' },
    journal: { current: async () => ({ ...activeJournal(), operation: 'reset' }) },
  });
  await assert.rejects(() => materialization.ensure(request()), /active recreate lifecycle/u);
  assert.equal(calls, 0);
});

test('recreate retirement is bound to verified journal generations, authorization subject, and exact superseded identity', async () => {
  let calls = 0;
  const retirement = createEnvironmentRecreateRetirement({
    state: {
      async retireSupersededEnvironment(identity, options) {
        calls += 1;
        assert.equal(identity, NEXT);
        assert.deepEqual(options, { supersededIdentity: OLD });
        return { identity: OLD, removed: false, absent: true };
      },
    },
    journal: { current: async () => activeJournal('verification') },
  });
  const result = await retirement.ensure({
    environmentIdentity: 'logical-environment-a', operationId: 'lifecycle-recreate-1', declarationRevision: 1,
    previousImplementationGeneration: OLD, implementationGeneration: NEXT, authorizationSubject: AUTHORIZATION,
  });
  assert.deepEqual(result, { ready: true, identity: OLD, removed: false, absent: true });
  assert.equal(calls, 1);
});

test('recreate retirement refuses authorization drift before provider deletion', async () => {
  let calls = 0;
  const retirement = createEnvironmentRecreateRetirement({
    state: { async retireSupersededEnvironment() { calls += 1; return { identity: OLD, removed: true, absent: false }; } },
    journal: { current: async () => activeJournal('verification') },
  });
  await assert.rejects(() => retirement.ensure({
    environmentIdentity: 'logical-environment-a', operationId: 'lifecycle-recreate-1', declarationRevision: 1,
    previousImplementationGeneration: OLD, implementationGeneration: NEXT, authorizationSubject: `recreate-${'b'.repeat(64)}`,
  }), /authorization evidence changed/u);
  assert.equal(calls, 0);
});
