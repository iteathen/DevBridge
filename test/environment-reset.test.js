import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENT_DECLARATION_PROTOCOL, EnvironmentDeclarationRegistry } from '../src/runtime/environment-declaration.js';
import { ENVIRONMENT_LIFECYCLE_STAGES, EnvironmentLifecycleJournal } from '../src/runtime/environment-lifecycle-journal.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL } from '../src/runtime/environment-observation.js';
import { EnvironmentReset } from '../src/runtime/environment-reset.js';

const OLD = `env-${'1'.repeat(32)}`;
const NEXT = `env-${'2'.repeat(32)}`;

function declaration(protectedStateClasses = []) {
  return {
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: 'linux-development', schemaGeneration: 'profile-v1',
    guest: { family: 'ubuntu', generation: '24.04.4' },
    image: { identity: 'image-ubuntu-v1', generation: 'ubuntu-v1' },
    resources: { memoryBytes: 4294967296, processorCount: 4 },
    boot: { requirement: 'efi-v1' }, network: { requirement: 'managed-egress-v1' },
    bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
    enrollment: { requirement: 'unique-guest-trust-v1' },
    workspaces: [
      { identity: 'workspace-a', authority: 'authority-a' },
      { identity: 'workspace-b', authority: 'authority-b' },
    ],
    protectedStateClasses,
  };
}
function memoryPort() { const values = new Map(); return { async load(key) { return structuredClone(values.get(key) ?? null); }, async save(key, value) { values.set(key, structuredClone(value)); }, async scan() { return [...values.values()].map((value) => structuredClone(value)); } }; }
function declarationPort() { const values = new Map(); return { async load(key) { return structuredClone(values.get(key) ?? null); }, async save(key, value) { values.set(key, structuredClone(value)); }, async scan() { return [...values.values()].map((value) => structuredClone(value)); } }; }
function observation(record, generation, healthy = true) {
  return {
    protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
    environmentIdentity: record.identity,
    declarationRevision: record.revision,
    implementationGeneration: generation,
    materialization: 'present',
    systemStorage: healthy ? 'present' : 'invalid',
    attachment: healthy ? 'ready' : 'invalid',
    enrollment: healthy ? 'ready' : 'unknown',
    bootstrap: healthy ? 'ready' : 'unknown',
    guest: healthy ? 'healthy' : 'unknown',
    transition: 'clear',
  };
}
async function fixture(protectedStateClasses = []) {
  const declarations = new EnvironmentDeclarationRegistry({ port: declarationPort(), now: () => '2026-08-23T00:00:00.000Z' });
  const registered = (await declarations.register(declaration(protectedStateClasses))).record;
  const journal = new EnvironmentLifecycleJournal({ port: memoryPort(), now: () => '2026-08-23T00:00:01.000Z', id: () => 'lifecycle-reset-1' });
  return { declarations, registered, journal };
}
function readyEvidence(state = null) {
  return { inspect: async () => ({ resources: 'ready', network: state?.network ?? 'ready', workspaces: 'ready' }) };
}
function ports(f, overrides = {}) {
  return {
    declarations: f.declarations,
    journal: f.journal,
    observer: { observe: async () => observation(f.registered, OLD, true) },
    fence: { acquire: async () => ({ subject: 'fence-reset', release: async () => {} }) },
    construction: { run: async () => ({ implementationGeneration: NEXT }), clear: async () => {} },
    retirement: { ensure: async () => ({ ready: true }) },
    evidence: readyEvidence(),
    ...overrides,
  };
}

test('reset binds profile-wide impact to local authorization, verifies readiness, then retires the exact old generation', async () => {
  const f = await fixture();
  let generation = OLD;
  let healthy = true;
  let retired = 0;
  let cleared = 0;
  const authorizationSubjects = [];
  const reset = new EnvironmentReset({
    declarations: f.declarations,
    journal: f.journal,
    observer: { observe: async () => observation(f.registered, generation, healthy) },
    fence: { acquire: async () => ({ subject: 'fence-reset-1', release: async () => {} }) },
    construction: {
      run: async (request) => {
        assert.equal(request.environmentIdentity, f.registered.identity);
        assert.equal(request.operationId, 'lifecycle-reset-1');
        generation = NEXT;
        healthy = true;
        return { state: 'ready', implementationGeneration: NEXT, observation: observation(f.registered, NEXT, true) };
      },
      clear: async () => { cleared += 1; },
    },
    retirement: {
      ensure: async (input) => {
        assert.equal(generation, NEXT);
        assert.equal(input.previousImplementationGeneration, OLD);
        assert.equal(input.implementationGeneration, NEXT);
        assert.match(input.authorizationSubject, /^reset-[a-f0-9]{64}$/u);
        retired += 1;
        return { ready: true };
      },
    },
    evidence: readyEvidence(),
    authorization: {
      verify: async (input) => {
        assert.equal(input.approval, 'operator-approved-reset');
        authorizationSubjects.push(input.subject);
        return { approved: true, subject: input.subject };
      },
    },
  });

  const impact = await reset.plan(f.registered.identity);
  assert.deepEqual(impact.affectedWorkspaces, ['workspace-a', 'workspace-b']);
  assert.equal(impact.affectedWorkspaceCount, 2);
  assert.equal(impact.blocked, false);
  assert.equal(impact.implementationGenerationChanges, true);
  assert.equal(impact.rollback, 'superseded-generation-retained-until-verification');
  assert.equal(impact.discards.includes('workspace-materialization'), true);
  assert.match(impact.authorizationSubject, /^reset-[a-f0-9]{64}$/u);

  const result = await reset.reset(f.registered.identity, { approval: 'operator-approved-reset' });
  assert.equal(result.state, 'complete');
  assert.equal(result.previousImplementationGeneration, OLD);
  assert.equal(result.implementationGeneration, NEXT);
  assert.equal(result.authorizationSubject, impact.authorizationSubject);
  assert.deepEqual(authorizationSubjects, [impact.authorizationSubject]);
  assert.equal(retired, 1);
  assert.equal(cleared, 1);
  const record = await f.journal.current(f.registered.identity);
  assert.deepEqual(record.entries.map((entry) => entry.stage), ENVIRONMENT_LIFECYCLE_STAGES);
  assert.equal(record.entries.find((entry) => entry.stage === 'verification').implementationGeneration, NEXT);
  assert.equal(record.entries.find((entry) => entry.stage === 'cleanup-reconciliation').implementationGeneration, NEXT);
});

test('protected state and changed post-authorization impact fail before construction or retirement', async () => {
  const blocked = await fixture(['database-state']);
  let authorizationCalls = 0;
  let constructionCalls = 0;
  const blockedReset = new EnvironmentReset({
    declarations: blocked.declarations,
    journal: blocked.journal,
    observer: { observe: async () => observation(blocked.registered, OLD, true) },
    fence: { acquire: async () => ({ subject: 'fence-reset-blocked', release: async () => {} }) },
    construction: { run: async () => { constructionCalls += 1; return { implementationGeneration: NEXT }; }, clear: async () => {} },
    retirement: { ensure: async () => { throw new Error('unused'); } },
    evidence: readyEvidence(),
    authorization: { verify: async (input) => { authorizationCalls += 1; return { approved: true, subject: input.subject }; } },
  });
  const blockedImpact = await blockedReset.plan(blocked.registered.identity);
  assert.equal(blockedImpact.blocked, true);
  assert.equal(blockedImpact.affectedWorkspaceCount, 2);
  assert.deepEqual(blockedImpact.protectedState, ['database-state']);
  assert.equal(blockedImpact.blockers.includes('protected-state'), true);
  await assert.rejects(() => blockedReset.reset(blocked.registered.identity, { approval: 'approved' }), /protected state/u);
  assert.equal(authorizationCalls, 0);
  assert.equal(constructionCalls, 0);

  const changed = await fixture();
  const state = { network: 'ready' };
  let retirementCalls = 0;
  const changedReset = new EnvironmentReset({
    declarations: changed.declarations,
    journal: changed.journal,
    observer: { observe: async () => observation(changed.registered, OLD, true) },
    fence: { acquire: async () => ({ subject: 'fence-reset-changed', release: async () => {} }) },
    construction: { run: async () => { constructionCalls += 1; return { implementationGeneration: NEXT }; }, clear: async () => {} },
    retirement: { ensure: async () => { retirementCalls += 1; return { ready: true }; } },
    evidence: readyEvidence(state),
    authorization: {
      verify: async (input) => {
        state.network = 'degraded';
        return { approved: true, subject: input.subject };
      },
    },
  });
  await assert.rejects(() => changedReset.reset(changed.registered.identity, { approval: 'approved' }), /impact changed/u);
  assert.equal(retirementCalls, 0);
});

test('reset resumes an ambiguous replacement effect through the same lifecycle operation without reauthorization', async () => {
  const f = await fixture();
  let generation = OLD;
  let first = true;
  let constructionCalls = 0;
  let authorizationCalls = 0;
  let retirementCalls = 0;
  const reset = new EnvironmentReset({
    declarations: f.declarations,
    journal: f.journal,
    observer: { observe: async () => observation(f.registered, generation, true) },
    fence: { acquire: async () => ({ subject: 'fence-reset-stable', release: async () => {} }) },
    construction: {
      run: async () => {
        constructionCalls += 1;
        generation = NEXT;
        if (first) { first = false; throw new Error('interrupted after replacement effect'); }
        return { state: 'ready', implementationGeneration: NEXT, observation: observation(f.registered, NEXT, true) };
      },
      clear: async () => {},
    },
    retirement: { ensure: async () => { retirementCalls += 1; return { ready: true }; } },
    evidence: readyEvidence(),
    authorization: { verify: async (input) => { authorizationCalls += 1; return { approved: true, subject: input.subject }; } },
  });

  await assert.rejects(() => reset.reset(f.registered.identity, { approval: 'approved' }), /interrupted/u);
  assert.equal((await f.journal.current(f.registered.identity)).entries.at(-1).stage, 'fenced-attempt');
  const result = await reset.reset(f.registered.identity);
  assert.equal(result.state, 'complete');
  assert.equal(result.implementationGeneration, NEXT);
  assert.equal(authorizationCalls, 1);
  assert.equal(constructionCalls, 2);
  assert.equal(retirementCalls, 1);
});

test('profile reset rejects workspace-local authority fields and has no default destructive authorization', async () => {
  const f = await fixture();
  let authorizationCalls = 0;
  const reset = new EnvironmentReset(ports(f, {
    authorization: { verify: async () => { authorizationCalls += 1; return { approved: true, subject: 'unused' }; } },
  }));
  await assert.rejects(() => reset.reset(f.registered.identity, { approval: 'approved', workspaceIdentity: 'workspace-a' }), /workspaceIdentity is not allowed/u);
  assert.equal(authorizationCalls, 0);

  const noAuthority = new EnvironmentReset(ports(f, { authorization: null }));
  await assert.rejects(() => noAuthority.reset(f.registered.identity, { approval: 'just-a-string' }), /local destructive authorization is unavailable/u);
});

test('reset resume rejects changed fence authority before another construction effect', async () => {
  const f = await fixture();
  let acquisition = 0;
  let constructionCalls = 0;
  let authorizationCalls = 0;
  const reset = new EnvironmentReset(ports(f, {
    fence: { acquire: async () => ({ subject: ++acquisition === 1 ? 'fence-a' : 'fence-b', release: async () => {} }) },
    construction: { run: async () => { constructionCalls += 1; throw new Error('interrupted before replacement'); }, clear: async () => {} },
    authorization: { verify: async (input) => { authorizationCalls += 1; return { approved: true, subject: input.subject }; } },
  }));
  await assert.rejects(() => reset.reset(f.registered.identity, { approval: 'approved' }), /interrupted/u);
  assert.equal(constructionCalls, 1);
  await assert.rejects(() => reset.reset(f.registered.identity), /fence subject changed/u);
  assert.equal(constructionCalls, 1);
  assert.equal(authorizationCalls, 1);
});
