import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENT_DECLARATION_PROTOCOL, EnvironmentDeclarationRegistry } from '../src/runtime/environment-declaration.js';
import { ENVIRONMENT_LIFECYCLE_STAGES, EnvironmentLifecycleJournal } from '../src/runtime/environment-lifecycle-journal.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL } from '../src/runtime/environment-observation.js';
import { EnvironmentRepair } from '../src/runtime/environment-repair.js';

function declaration() { return { protocol: ENVIRONMENT_DECLARATION_PROTOCOL, profile: 'linux-development', schemaGeneration: 'profile-v1', guest: { family: 'ubuntu', generation: '24.04.4' }, image: { identity: 'image-ubuntu-v1', generation: 'ubuntu-v1' }, resources: { memoryBytes: 4294967296, processorCount: 4 }, boot: { requirement: 'efi-v1' }, network: { requirement: 'managed-egress-v1' }, bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] }, enrollment: { requirement: 'unique-guest-trust-v1' }, workspaces: [], protectedStateClasses: [] }; }
function port() { const values = new Map(); return { async load(key) { return structuredClone(values.get(key) ?? null); }, async save(key, value) { values.set(key, structuredClone(value)); }, async scan() { return [...values.values()].map((value) => structuredClone(value)); } }; }
async function fixture() { const declarations = new EnvironmentDeclarationRegistry({ port: port(), now: () => '2026-08-22T23:15:00.000Z' }); const registered = await declarations.register(declaration()); const journal = new EnvironmentLifecycleJournal({ port: port(), now: () => '2026-08-22T23:15:01.000Z', id: () => 'lifecycle-repair-1' }); return { declarations, record: registered.record, journal }; }
function observation(record, overrides = {}) { return { protocol: ENVIRONMENT_OBSERVATION_PROTOCOL, environmentIdentity: record.identity, declarationRevision: record.revision, implementationGeneration: 'implementation-1', materialization: 'present', systemStorage: 'present', attachment: 'ready', enrollment: 'ready', bootstrap: 'ready', guest: 'healthy', transition: 'clear', ...overrides }; }

test('repair refuses missing system storage without invoking a correction', async () => {
  const f = await fixture(); let corrections = 0;
  const repair = new EnvironmentRepair({ declarations: f.declarations, journal: f.journal, observer: { observe: async () => observation(f.record, { systemStorage: 'absent' }) }, fence: { acquire: async () => ({ subject: 'fence-1', release: async () => {} }) }, correction: { ensure: async () => { corrections += 1; } } });
  await assert.rejects(() => repair.repair(f.record.identity), /supported next action: rebuild/u);
  assert.equal(corrections, 0);
  assert.equal(await f.journal.current(f.record.identity), null);
});

test('repair journals one fenced in-place correction and preserves implementation generation', async () => {
  const f = await fixture(); let state = 'degraded'; let fenceHeld = false; let corrections = 0;
  const repair = new EnvironmentRepair({
    declarations: f.declarations, journal: f.journal,
    observer: { observe: async () => observation(f.record, state === 'degraded' ? { bootstrap: 'degraded' } : {}) },
    fence: { acquire: async () => { fenceHeld = true; return { subject: 'fence-1', release: async () => { fenceHeld = false; } }; } },
    correction: { ensure: async (request) => { assert.equal(fenceHeld, true); assert.equal(request.cause, 'bootstrap-degraded'); corrections += 1; state = 'ready'; return { ready: true }; } },
  });
  const result = await repair.repair(f.record.identity);
  assert.equal(result.state, 'complete');
  assert.equal(result.repairedCause, 'bootstrap-degraded');
  assert.equal(result.implementationGeneration, 'implementation-1');
  assert.equal(corrections, 1);
  const journal = await f.journal.current(f.record.identity);
  assert.deepEqual(journal.entries.map((entry) => entry.stage), ENVIRONMENT_LIFECYCLE_STAGES);
  assert.equal(journal.entries.find((entry) => entry.stage === 'pre-observation').subjects[0], 'bootstrap-degraded');
});

test('interrupted correction reconciles by observation and is not blindly replayed', async () => {
  const f = await fixture(); let state = 'degraded'; let corrections = 0;
  const repair = new EnvironmentRepair({
    declarations: f.declarations, journal: f.journal,
    observer: { observe: async () => observation(f.record, state === 'degraded' ? { enrollment: 'stale' } : {}) },
    fence: { acquire: async () => ({ subject: 'fence-stable', release: async () => {} }) },
    correction: { ensure: async () => { corrections += 1; state = 'ready'; throw new Error('lost response after effect'); } },
  });
  await assert.rejects(() => repair.repair(f.record.identity), /lost response/u);
  assert.equal((await f.journal.current(f.record.identity)).entries.at(-1).stage, 'fenced-attempt');
  const result = await repair.repair(f.record.identity);
  assert.equal(result.state, 'complete');
  assert.equal(corrections, 1);
});

test('repair resume rejects changed fence authority before another correction', async () => {
  const f = await fixture(); let acquisitions = 0; let corrections = 0;
  const repair = new EnvironmentRepair({
    declarations: f.declarations, journal: f.journal,
    observer: { observe: async () => observation(f.record, { attachment: 'invalid' }) },
    fence: { acquire: async () => { acquisitions += 1; return { subject: acquisitions === 1 ? 'fence-a' : 'fence-b', release: async () => {} }; } },
    correction: { ensure: async () => { corrections += 1; throw new Error('interrupted'); } },
  });
  await assert.rejects(() => repair.repair(f.record.identity), /interrupted/u);
  await assert.rejects(() => repair.repair(f.record.identity), /fence subject changed/u);
  assert.equal(corrections, 1);
});
