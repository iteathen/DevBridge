import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENT_DECLARATION_PROTOCOL, EnvironmentDeclarationRegistry } from '../src/runtime/environment-declaration.js';
import { ENVIRONMENT_LIFECYCLE_STAGES, EnvironmentLifecycleJournal } from '../src/runtime/environment-lifecycle-journal.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL } from '../src/runtime/environment-observation.js';
import { EnvironmentRebuild } from '../src/runtime/environment-rebuild.js';

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
    workspaces: [{ identity: 'workspace-a', authority: 'authority-a' }],
    protectedStateClasses,
  };
}
function memoryPort() { const values = new Map(); return { async load(key) { return structuredClone(values.get(key) ?? null); }, async save(key, value) { values.set(key, structuredClone(value)); }, async scan() { return [...values.values()].map((value) => structuredClone(value)); } }; }
function declarationPort() { const values = new Map(); return { async load(key) { return structuredClone(values.get(key) ?? null); }, async save(key, value) { values.set(key, structuredClone(value)); }, async scan() { return [...values.values()].map((value) => structuredClone(value)); } }; }
function observation(record, generation, storage = 'absent') {
  if (storage === 'healthy') return {
    protocol: ENVIRONMENT_OBSERVATION_PROTOCOL, environmentIdentity: record.identity, declarationRevision: record.revision,
    implementationGeneration: generation, materialization: 'present', systemStorage: 'present', attachment: 'ready', enrollment: 'ready', bootstrap: 'ready', guest: 'healthy', transition: 'clear',
  };
  return {
    protocol: ENVIRONMENT_OBSERVATION_PROTOCOL, environmentIdentity: record.identity, declarationRevision: record.revision,
    implementationGeneration: generation, materialization: 'present', systemStorage: storage, attachment: 'invalid', enrollment: 'unknown', bootstrap: 'unknown', guest: 'unknown', transition: 'clear',
  };
}
async function fixture(protectedStateClasses = []) {
  const declarations = new EnvironmentDeclarationRegistry({ port: declarationPort(), now: () => '2026-08-22T23:00:00.000Z' });
  const registered = (await declarations.register(declaration(protectedStateClasses))).record;
  const journal = new EnvironmentLifecycleJournal({ port: memoryPort(), now: () => '2026-08-22T23:00:01.000Z', id: () => 'lifecycle-rebuild-1' });
  return { declarations, registered, journal };
}
function evidence() { return { inspect: async () => ({ resources: 'ready', network: 'ready', workspaces: 'ready' }) }; }

test('rebuild impact and lifecycle preserve logical identity while replacing implementation generation', async () => {
  const f = await fixture();
  let generation = OLD;
  let storage = 'absent';
  let fenceHeld = false;
  let cleared = 0;
  const rebuild = new EnvironmentRebuild({
    declarations: f.declarations, journal: f.journal,
    observer: { observe: async () => observation(f.registered, generation, storage) },
    fence: { acquire: async () => ({ subject: 'fence-rebuild-1', release: async () => { fenceHeld = false; } }) },
    construction: {
      run: async (request) => {
        fenceHeld = true;
        assert.equal(request.environmentIdentity, f.registered.identity);
        assert.equal(request.operationId, 'lifecycle-rebuild-1');
        generation = NEXT; storage = 'healthy';
        return { state: 'ready', implementationGeneration: NEXT, observation: observation(f.registered, NEXT, 'healthy') };
      },
      clear: async () => { cleared += 1; },
    },
    evidence: evidence(),
  });
  const impact = await rebuild.plan(f.registered.identity);
  assert.equal(impact.systemStorage, 'missing');
  assert.equal(impact.currentImplementationGeneration, OLD);
  assert.deepEqual(impact.reseeds, ['workspace-a']);
  assert.equal(impact.blocked, false);

  const result = await rebuild.rebuild(f.registered.identity);
  assert.equal(result.state, 'complete');
  assert.equal(result.previousImplementationGeneration, OLD);
  assert.equal(result.implementationGeneration, NEXT);
  assert.equal(result.rebuiltCause, 'system-storage-missing');
  assert.equal(cleared, 1);
  const record = await f.journal.current(f.registered.identity);
  assert.deepEqual(record.entries.map((entry) => entry.stage), ENVIRONMENT_LIFECYCLE_STAGES);
});

test('rebuild resumes after an ambiguous construction effect without requiring the old generation to remain current', async () => {
  const f = await fixture();
  let generation = OLD;
  let storage = 'invalid';
  let first = true;
  let calls = 0;
  const rebuild = new EnvironmentRebuild({
    declarations: f.declarations, journal: f.journal,
    observer: { observe: async () => observation(f.registered, generation, storage) },
    fence: { acquire: async () => ({ subject: 'fence-rebuild-stable', release: async () => {} }) },
    construction: {
      run: async () => {
        calls += 1;
        generation = NEXT; storage = 'healthy';
        if (first) { first = false; throw new Error('interrupted after replacement effect'); }
        return { state: 'ready', implementationGeneration: NEXT, observation: observation(f.registered, NEXT, 'healthy') };
      },
      clear: async () => {},
    },
    evidence: evidence(),
  });
  await assert.rejects(() => rebuild.rebuild(f.registered.identity), /interrupted/u);
  assert.equal((await f.journal.current(f.registered.identity)).entries.at(-1).stage, 'fenced-attempt');
  const result = await rebuild.rebuild(f.registered.identity);
  assert.equal(result.state, 'complete');
  assert.equal(result.implementationGeneration, NEXT);
  assert.equal(calls, 2);
});

test('rebuild refuses protected state, healthy state, and changed fence authority', async () => {
  const blocked = await fixture(['database-state']);
  const blockedRebuild = new EnvironmentRebuild({
    declarations: blocked.declarations, journal: blocked.journal,
    observer: { observe: async () => observation(blocked.registered, OLD, 'absent') },
    fence: { acquire: async () => ({ subject: 'fence', release: async () => {} }) },
    construction: { run: async () => { throw new Error('unused'); }, clear: async () => {} }, evidence: evidence(),
  });
  const impact = await blockedRebuild.plan(blocked.registered.identity);
  assert.equal(impact.blocked, true);
  await assert.rejects(() => blockedRebuild.rebuild(blocked.registered.identity), /protected state/u);

  const healthy = await fixture();
  const healthyRebuild = new EnvironmentRebuild({
    declarations: healthy.declarations, journal: healthy.journal,
    observer: { observe: async () => observation(healthy.registered, OLD, 'healthy') },
    fence: { acquire: async () => ({ subject: 'fence', release: async () => {} }) },
    construction: { run: async () => { throw new Error('unused'); }, clear: async () => {} }, evidence: evidence(),
  });
  await assert.rejects(() => healthyRebuild.plan(healthy.registered.identity), /not the supported next action/u);

  const changed = await fixture();
  let acquisition = 0;
  let first = true;
  const changedRebuild = new EnvironmentRebuild({
    declarations: changed.declarations, journal: changed.journal,
    observer: { observe: async () => observation(changed.registered, OLD, 'absent') },
    fence: { acquire: async () => { acquisition += 1; return { subject: acquisition === 1 ? 'fence-a' : 'fence-b', release: async () => {} }; } },
    construction: { run: async () => { if (first) { first = false; throw new Error('interrupted'); } return { implementationGeneration: NEXT }; }, clear: async () => {} }, evidence: evidence(),
  });
  await assert.rejects(() => changedRebuild.rebuild(changed.registered.identity), /interrupted/u);
  await assert.rejects(() => changedRebuild.rebuild(changed.registered.identity), /fence subject changed/u);
});
