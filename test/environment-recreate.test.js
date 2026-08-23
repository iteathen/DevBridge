import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENT_DECLARATION_PROTOCOL, EnvironmentDeclarationRegistry } from '../src/runtime/environment-declaration.js';
import { ENVIRONMENT_LIFECYCLE_STAGES, EnvironmentLifecycleJournal } from '../src/runtime/environment-lifecycle-journal.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL } from '../src/runtime/environment-observation.js';
import { EnvironmentRecreate } from '../src/runtime/environment-recreate.js';

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
function observation(record, generation, materialization = 'present', healthy = true) {
  const present = materialization === 'present';
  const ready = present && healthy;
  return {
    protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
    environmentIdentity: record.identity,
    declarationRevision: record.revision,
    implementationGeneration: generation,
    materialization,
    systemStorage: ready ? 'present' : materialization === 'missing' ? 'unknown' : 'invalid',
    attachment: ready ? 'ready' : 'unknown',
    enrollment: ready ? 'ready' : 'unknown',
    bootstrap: ready ? 'ready' : 'unknown',
    guest: ready ? 'healthy' : 'unknown',
    transition: 'clear',
  };
}
async function fixture(protectedStateClasses = []) {
  const declarations = new EnvironmentDeclarationRegistry({ port: declarationPort(), now: () => '2026-08-23T01:00:00.000Z' });
  const registered = (await declarations.register(declaration(protectedStateClasses))).record;
  const journal = new EnvironmentLifecycleJournal({ port: memoryPort(), now: () => '2026-08-23T01:00:01.000Z', id: () => 'lifecycle-recreate-1' });
  return { declarations, registered, journal };
}
function evidence(resources = 'ready') { return { inspect: async () => ({ resources, network: 'ready', workspaces: 'ready' }) }; }
function authorization(onVerify = null) {
  return {
    async verify(input) {
      onVerify?.(input);
      return { approved: true, subject: input.subject };
    },
  };
}

test('recreate preview distinguishes retained rollback from an already-missing provider and binds an exact authorization subject', async () => {
  const f = await fixture();
  let materialization = 'present';
  const recreate = new EnvironmentRecreate({
    declarations: f.declarations,
    journal: f.journal,
    observer: { observe: async () => observation(f.registered, OLD, materialization, materialization === 'present') },
    fence: { acquire: async () => ({ subject: 'fence-recreate', release: async () => {} }) },
    construction: { run: async () => ({ implementationGeneration: NEXT }), clear: async () => {} },
    retirement: { ensure: async () => ({ ready: true }) },
    evidence: evidence(),
  });
  const present = await recreate.plan(f.registered.identity);
  assert.equal(present.destructive, true);
  assert.equal(present.previousProvider, 'present');
  assert.equal(present.sideBySideReplacement, true);
  assert.equal(present.rollback, 'superseded-generation-retained-until-verification');
  assert.equal(present.destructiveFallback.automatic, false);
  assert.deepEqual(present.affectedWorkspaces, ['workspace-a', 'workspace-b']);
  assert.equal(present.affectedWorkspaceCount, 2);
  assert.deepEqual(present.reseeds, ['workspace-a', 'workspace-b']);
  assert.match(present.authorizationSubject, /^recreate-[a-f0-9]{64}$/u);
  assert.equal(present.blocked, false);

  materialization = 'missing';
  const missing = await recreate.plan(f.registered.identity);
  assert.equal(missing.previousProvider, 'missing');
  assert.equal(missing.sideBySideReplacement, false);
  assert.equal(missing.rollback, 'unavailable-provider-already-missing');
  assert.notEqual(missing.authorizationSubject, present.authorizationSubject);
  assert.equal(missing.blocked, false);
});

test('recreate runs shared construction, verifies the replacement, then retires the exact old generation under the approved impact', async () => {
  const f = await fixture();
  let generation = OLD;
  let retired = 0;
  let cleared = 0;
  let approvedSubject = null;
  const recreate = new EnvironmentRecreate({
    declarations: f.declarations,
    journal: f.journal,
    observer: { observe: async () => observation(f.registered, generation, 'present', true) },
    fence: { acquire: async () => ({ subject: 'fence-recreate-stable', release: async () => {} }) },
    construction: {
      run: async (request) => {
        assert.equal(request.operationId, 'lifecycle-recreate-1');
        generation = NEXT;
        return { state: 'ready', implementationGeneration: NEXT, observation: observation(f.registered, NEXT, 'present', true) };
      },
      clear: async () => { cleared += 1; },
    },
    retirement: {
      ensure: async (input) => {
        assert.equal(input.previousImplementationGeneration, OLD);
        assert.equal(input.implementationGeneration, NEXT);
        assert.equal(input.authorizationSubject, approvedSubject);
        retired += 1;
        return { ready: true };
      },
    },
    evidence: evidence(),
    authorization: authorization((input) => {
      assert.equal(input.operation, 'recreate');
      assert.equal(input.approval, 'approved-impact');
      assert.equal(input.implementationGeneration, OLD);
      approvedSubject = input.subject;
    }),
  });

  const result = await recreate.recreate(f.registered.identity, { approval: 'approved-impact' });
  assert.equal(result.state, 'complete');
  assert.equal(result.previousImplementationGeneration, OLD);
  assert.equal(result.implementationGeneration, NEXT);
  assert.equal(result.authorizationSubject, approvedSubject);
  assert.equal(result.rollback, 'retired-after-verification');
  assert.equal(retired, 1);
  assert.equal(cleared, 1);
  const record = await f.journal.current(f.registered.identity);
  assert.deepEqual(record.entries.map((entry) => entry.stage), ENVIRONMENT_LIFECYCLE_STAGES);
  assert.equal(record.entries.find((entry) => entry.stage === 'pre-observation').subjects[0], approvedSubject);
});

test('recreate refuses changed impact after authorization before shared construction runs', async () => {
  const f = await fixture();
  let observations = 0;
  let constructionCalls = 0;
  const recreate = new EnvironmentRecreate({
    declarations: f.declarations,
    journal: f.journal,
    observer: {
      observe: async () => {
        observations += 1;
        const value = observation(f.registered, OLD, 'present', true);
        if (observations > 1) return { ...value, systemStorage: 'invalid', attachment: 'invalid', enrollment: 'unknown', bootstrap: 'unknown', guest: 'unknown' };
        return value;
      },
    },
    fence: { acquire: async () => ({ subject: 'fence-recreate-drift', release: async () => {} }) },
    construction: { run: async () => { constructionCalls += 1; return { implementationGeneration: NEXT }; }, clear: async () => {} },
    retirement: { ensure: async () => ({ ready: true }) },
    evidence: evidence(),
    authorization: authorization(),
  });
  await assert.rejects(() => recreate.recreate(f.registered.identity, { approval: 'approved-impact' }), /impact changed after destructive authorization/u);
  assert.equal(constructionCalls, 0);
});

test('recreate refuses mismatched destructive authorization before creating a lifecycle mutation record', async () => {
  const f = await fixture();
  let constructionCalls = 0;
  const recreate = new EnvironmentRecreate({
    declarations: f.declarations,
    journal: f.journal,
    observer: { observe: async () => observation(f.registered, OLD, 'present', true) },
    fence: { acquire: async () => ({ subject: 'fence-recreate-auth', release: async () => {} }) },
    construction: { run: async () => { constructionCalls += 1; return { implementationGeneration: NEXT }; }, clear: async () => {} },
    retirement: { ensure: async () => ({ ready: true }) },
    evidence: evidence(),
    authorization: { verify: async () => ({ approved: true, subject: `recreate-${'0'.repeat(64)}` }) },
  });
  await assert.rejects(() => recreate.recreate(f.registered.identity, { approval: 'wrong-impact' }), /did not match the exact impact subject/u);
  assert.equal(await f.journal.current(f.registered.identity), null);
  assert.equal(constructionCalls, 0);
});

test('interrupted recreate exposes deterministic resume instructions and reuses the same lifecycle operation', async () => {
  const f = await fixture();
  let generation = OLD;
  let first = true;
  let constructionCalls = 0;
  let retirementCalls = 0;
  const recreate = new EnvironmentRecreate({
    declarations: f.declarations,
    journal: f.journal,
    observer: { observe: async () => observation(f.registered, generation, 'present', true) },
    fence: { acquire: async () => ({ subject: 'fence-recreate-resume', release: async () => {} }) },
    construction: {
      run: async () => {
        constructionCalls += 1;
        generation = NEXT;
        if (first) { first = false; throw new Error('interrupted after provider effect'); }
        return { state: 'ready', implementationGeneration: NEXT, observation: observation(f.registered, NEXT, 'present', true) };
      },
      clear: async () => {},
    },
    retirement: { ensure: async () => { retirementCalls += 1; return { ready: true }; } },
    evidence: evidence(),
    authorization: authorization(),
  });

  let failure;
  try { await recreate.recreate(f.registered.identity, { approval: 'approved-impact' }); } catch (error) { failure = error; }
  assert.match(failure.message, /interrupted/u);
  assert.deepEqual(failure.recovery, {
    state: 'resume-required', environmentIdentity: f.registered.identity, operationId: 'lifecycle-recreate-1', stage: 'fenced-attempt', previousProvider: 'present',
    instruction: 're-run recreate for the same logical environment with the same approved impact; do not manually delete provider objects selected by the active lifecycle operation',
  });
  const resumed = await recreate.recreate(f.registered.identity);
  assert.equal(resumed.state, 'complete');
  assert.equal(constructionCalls, 2);
  assert.equal(retirementCalls, 1);
});

test('recreate blocks protected state, ambiguous provider selection, and resource admission before construction', async () => {
  const protectedFixture = await fixture(['database-state']);
  let constructionCalls = 0;
  const protectedRecreate = new EnvironmentRecreate({
    declarations: protectedFixture.declarations,
    journal: protectedFixture.journal,
    observer: { observe: async () => observation(protectedFixture.registered, OLD, 'present', true) },
    fence: { acquire: async () => ({ subject: 'fence-protected', release: async () => {} }) },
    construction: { run: async () => { constructionCalls += 1; return { implementationGeneration: NEXT }; }, clear: async () => {} },
    retirement: { ensure: async () => ({ ready: true }) },
    evidence: evidence(),
    authorization: authorization(),
  });
  assert.equal((await protectedRecreate.plan(protectedFixture.registered.identity)).blocked, true);
  await assert.rejects(() => protectedRecreate.recreate(protectedFixture.registered.identity, { approval: 'approved-impact' }), /protected state/u);

  const ambiguous = await fixture();
  const ambiguousRecreate = new EnvironmentRecreate({
    declarations: ambiguous.declarations,
    journal: ambiguous.journal,
    observer: { observe: async () => ({ ...observation(ambiguous.registered, OLD, 'present', false), materialization: 'ambiguous', transition: 'ambiguous' }) },
    fence: { acquire: async () => ({ subject: 'fence-ambiguous', release: async () => {} }) },
    construction: { run: async () => { constructionCalls += 1; return { implementationGeneration: NEXT }; }, clear: async () => {} },
    retirement: { ensure: async () => ({ ready: true }) },
    evidence: evidence(),
    authorization: authorization(),
  });
  await assert.rejects(() => ambiguousRecreate.recreate(ambiguous.registered.identity, { approval: 'approved-impact' }), /ambiguous or unavailable provider selection/u);

  const constrained = await fixture();
  const constrainedRecreate = new EnvironmentRecreate({
    declarations: constrained.declarations,
    journal: constrained.journal,
    observer: { observe: async () => observation(constrained.registered, OLD, 'present', true) },
    fence: { acquire: async () => ({ subject: 'fence-resource', release: async () => {} }) },
    construction: { run: async () => { constructionCalls += 1; return { implementationGeneration: NEXT }; }, clear: async () => {} },
    retirement: { ensure: async () => ({ ready: true }) },
    evidence: evidence('blocked'),
    authorization: authorization(),
  });
  await assert.rejects(() => constrainedRecreate.recreate(constrained.registered.identity, { approval: 'approved-impact' }), /resource prerequisites/u);
  assert.equal(constructionCalls, 0);
});
