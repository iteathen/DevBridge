import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentOperator } from '../src/app/environment-operator.js';
import { ENVIRONMENT_DECLARATION_PROTOCOL } from '../src/runtime/environment-declaration.js';

function record() {
  return Object.freeze({
    identity: 'environment-test',
    revision: 3,
    declaration: Object.freeze({
      protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
      profile: 'linux-development',
      schemaGeneration: 'schema-1',
      guest: Object.freeze({ family: 'linux', generation: 'guest-1' }),
      image: Object.freeze({ identity: 'image-1', generation: 'image-gen-1' }),
      resources: Object.freeze({ memoryBytes: 2 * 1024 * 1024 * 1024, processorCount: 2 }),
      boot: Object.freeze({ requirement: 'efi-v1' }),
      network: Object.freeze({ requirement: 'managed-egress-v1' }),
      bootstrap: Object.freeze({ generation: 'bootstrap-1', requirements: Object.freeze(['runtime-js']) }),
      enrollment: Object.freeze({ requirement: 'unique-guest-trust-v1' }),
      workspaces: Object.freeze([Object.freeze({ identity: 'workspace-1', authority: '42' })]),
      protectedStateClasses: Object.freeze([]),
    }),
  });
}

function runtimeFor({ current = null, diagnosis = null } = {}) {
  const selected = record();
  const calls = [];
  const runtime = {
    lifecycle: {
      declarations: {
        async list() { return [selected]; },
        async get(identity) { return identity === selected.identity ? selected : null; },
      },
      journal: {
        async current(identity) { return identity === selected.identity ? current : null; },
        async active() { return current ? [current] : []; },
      },
    },
    observer: {
      async observe() {
        return { implementationGeneration: 'generation-7', materialization: 'present', systemStorage: 'missing', attachment: 'ready', enrollment: 'ready', bootstrap: 'ready', guest: 'ready', transition: 'clear' };
      },
    },
    availability: {
      async inspect() { return { state: 'verified-local', localVerified: true, reacquirable: null, blocker: null }; },
    },
    async diagnose() {
      return diagnosis ?? {
        state: 'degraded', cause: 'system-storage-missing', repairableInPlace: false,
        supportedNextAction: 'rebuild', explanation: 'System storage is missing; rebuild is required.',
        impact: { destructive: true, preserves: ['logical-environment'], unavailable: ['system-storage'], reseedable: ['workspace-1'] },
      };
    },
    async planRebuild() { return { blocked: false, blockers: [], affectedWorkspaces: ['workspace-1'], currentImplementationGeneration: 'generation-7' }; },
    async rebuild(identity) { calls.push(['rebuild', identity]); return { completed: true }; },
    async create(identity) { calls.push(['create', identity]); return { completed: true }; },
    async repair(identity) { calls.push(['repair', identity]); return { completed: true }; },
    async planReset() { return { blocked: false, blockers: [], authorizationSubject: 'reset-subject' }; },
    async reset(identity) { calls.push(['reset', identity]); return { completed: true }; },
    async planRecreate() { return { blocked: false, blockers: [], authorizationSubject: 'recreate-subject' }; },
    async recreate(identity) { calls.push(['recreate', identity]); return { completed: true }; },
  };
  return { runtime, calls, selected };
}

test('operator reports rebuild as the next action for missing system storage without provider details', async () => {
  const { runtime } = runtimeFor();
  const operator = createEnvironmentOperator({ runtime });
  const status = await operator.status('environment-test');
  assert.equal(status.recommendedAction, 'rebuild');
  assert.equal(status.observed.implementationGeneration, 'generation-7');
  assert.equal(status.desiredGeneration.image, 'image-gen-1');
  assert.match(status.declarationDigest, /^[a-f0-9]{64}$/u);
  assert.equal(status.imageRecovery.localVerified, true);
  assert.equal(JSON.stringify(status).includes('path'), false);
});

test('operator requires the exact lifecycle-owned destructive confirmation subject', async () => {
  const { runtime, calls } = runtimeFor();
  const operator = createEnvironmentOperator({ runtime });
  const plan = await operator.plan('rebuild', 'environment-test');
  assert.equal(plan.destructive, true);
  assert.match(plan.authorizationSubject, /^rebuild-[a-f0-9]{64}$/u);
  await assert.rejects(() => operator.run('rebuild', 'environment-test'), /exact destructive confirmation/u);
  await operator.run('rebuild', 'environment-test', { approval: plan.authorizationSubject });
  assert.deepEqual(calls, [['rebuild', 'environment-test']]);
});

test('operator resumes an interrupted lifecycle stage through the same owner', async () => {
  const current = {
    operation: 'rebuild', operationId: 'operation-1',
    entries: [{ stage: 'post-observation', at: '2026-08-22T20:00:00.000Z' }],
  };
  const { runtime, calls } = runtimeFor({ current });
  const operator = createEnvironmentOperator({ runtime });
  const status = await operator.status('environment-test');
  assert.equal(status.recommendedAction, 'resume');
  assert.equal(status.lifecycle.stage, 'post-observation');
  await operator.resume('environment-test');
  assert.deepEqual(calls, [['rebuild', 'environment-test']]);
});

test('setup re-entry is a local capability handoff and grants no provider mutation', async () => {
  const { runtime } = runtimeFor();
  const operator = createEnvironmentOperator({ runtime });
  const handoff = await operator.setupReentry('environment-test');
  assert.equal(handoff.owner.trackingIssue, 116);
  assert.equal(handoff.authority.remoteIssueTextMayAuthorize, false);
  assert.equal(handoff.authority.remoteModelOutputMayAuthorize, false);
  assert.equal(handoff.authority.providerMutationAllowed, false);
});
