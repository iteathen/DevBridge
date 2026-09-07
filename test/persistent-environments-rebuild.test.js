import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersistentEnvironments } from '../src/runtime/persistent-environments.js';
import { createEnvironmentMaterialization, createEnvironmentRebuildMaterialization } from '../src/app/environment-materialization.js';
import { environmentObservationCondition } from '../src/runtime/environment-observation.js';

const SOURCE = 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET = 'img-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BINDING = '11111111111111111111111111111111';

function fixture() {
  const instances = new Map();
  let failAfterProvision = false;
  let provisionCalls = 0;
  const sources = new Map([
    [SOURCE, { identity: SOURCE, profile: 'guest-a', revision: '2026.08.1', digest: 'a'.repeat(64), handle: { token: 'a' } }],
    [TARGET, { identity: TARGET, profile: 'guest-a', revision: '2026.09.1', digest: 'b'.repeat(64), handle: { token: 'b' } }],
  ]);
  const source = {
    async resolve(identity) {
      if (!sources.has(identity)) throw new Error('source absent');
      return structuredClone(sources.get(identity));
    },
  };
  const absent = (identity) => ({ identity, exists: false, owned: false, compatible: false, state: 'absent', reason: 'absent', storage: null, storageState: 'unknown' });
  const operations = {
    async inspect() { return { identity: BINDING }; },
    async provision({ identity, source: selected }) {
      provisionCalls += 1;
      instances.set(identity, {
        identity, exists: true, owned: true, compatible: true, state: 'stopped', reason: null, storageState: 'present',
        storage: { identity: `storage-${identity}`, sourceIdentity: selected.identity, allocatedBytes: 4096 },
      });
      if (failAfterProvision) { failAfterProvision = false; throw new Error('simulated interruption after rebuild provider effect'); }
      return structuredClone(instances.get(identity));
    },
    async observe(identity) { return structuredClone(instances.get(identity) ?? absent(identity)); },
    async start(identity) { instances.get(identity).state = 'running'; return structuredClone(instances.get(identity)); },
    async stop(identity) { instances.get(identity).state = 'stopped'; return structuredClone(instances.get(identity)); },
    async drop(identity) { const removed = instances.delete(identity); return { identity, removed, absent: !removed }; },
  };
  return {
    source, sources, operations, instances,
    failNextProvision() { failAfterProvision = true; },
    provisionCalls() { return provisionCalls; },
  };
}

function request() {
  return { subject: 'immutable-subject-42', profile: 'guest-a', sourceIdentity: SOURCE, settings: { memoryBytes: 2147483648, processorCount: 2, firmware: 'efi' } };
}

function loseSystemStorage(fake, identity, state = 'absent') {
  fake.instances.set(identity, {
    identity, exists: true, owned: true, compatible: false, state: 'stopped',
    reason: state === 'absent' ? 'system storage missing' : 'system storage invalid',
    storage: null, storageState: state,
  });
}

test('rebuild replaces a missing-storage generation without requiring the old disk and retains damaged residue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-rebuild-registry-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    loseSystemStorage(fake, created.record.identity, 'absent');
    const rebuilt = await registry.rebuild(created.record.identity, {
      requestId: 'lifecycle-rebuild-1',
      expectedPreviousIdentity: created.record.identity,
    });
    assert.equal(rebuilt.record.generation, 2);
    assert.notEqual(rebuilt.record.identity, created.record.identity);
    assert.equal(rebuilt.record.source.identity, SOURCE);
    assert.equal(rebuilt.observation.compatible, true);
    assert.deepEqual(rebuilt.superseded, { identity: created.record.identity, cleanup: 'retained' });
    assert.equal(fake.instances.has(created.record.identity), true);
    assert.equal(fake.instances.has(rebuilt.record.identity), true);

    const repeated = await registry.rebuild(rebuilt.record.identity, {
      requestId: 'lifecycle-rebuild-1',
      expectedPreviousIdentity: created.record.identity,
    });
    assert.equal(repeated.record.identity, rebuilt.record.identity);
    assert.equal(fake.provisionCalls(), 2);
    assert.equal((await registry.list())[0].record.identity, rebuilt.record.identity);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rebuild waits for the outer lifecycle owner after restart, then reconciles the same provider effect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-rebuild-reconcile-'));
  const fake = fixture();
  try {
    let registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    loseSystemStorage(fake, created.record.identity, 'invalid');
    fake.failNextProvision();
    await assert.rejects(() => registry.rebuild(created.record.identity, {
      requestId: 'lifecycle-rebuild-2',
      expectedPreviousIdentity: created.record.identity,
    }), /simulated interruption/u);
    assert.equal(fake.instances.size, 2);

    registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const generic = await registry.reconcile();
    assert.equal(generic.length, 1);
    assert.equal(generic[0].record.identity, created.record.identity);
    assert.equal(generic[0].record.generation, 1);
    assert.equal(fake.provisionCalls(), 2);

    const reconciled = await registry.rebuild(created.record.identity, {
      requestId: 'lifecycle-rebuild-2',
      expectedPreviousIdentity: created.record.identity,
    });
    assert.equal(reconciled.record.generation, 2);
    assert.notEqual(reconciled.record.identity, created.record.identity);
    assert.equal(fake.provisionCalls(), 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rebuild rejects a healthy, foreign, running-unquiesceable, or stale previous generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-rebuild-guards-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    await assert.rejects(() => registry.rebuild(created.record.identity, {
      requestId: 'healthy-rebuild', expectedPreviousIdentity: created.record.identity,
    }), /requires missing or invalid/u);

    loseSystemStorage(fake, created.record.identity, 'absent');
    fake.instances.get(created.record.identity).owned = false;
    await assert.rejects(() => registry.rebuild(created.record.identity, {
      requestId: 'foreign-rebuild', expectedPreviousIdentity: created.record.identity,
    }), /ownership/u);

    loseSystemStorage(fake, created.record.identity, 'absent');
    fake.instances.get(created.record.identity).state = 'running';
    await assert.rejects(() => registry.rebuild(created.record.identity, {
      requestId: 'running-rebuild', expectedPreviousIdentity: created.record.identity,
    }), /safely quiesced/u);

    fake.instances.get(created.record.identity).state = 'stopped';
    await assert.rejects(() => registry.rebuild(created.record.identity, {
      requestId: 'stale-rebuild', expectedPreviousIdentity: `env-${'f'.repeat(32)}`,
    }), /previous implementation generation changed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('definitive rebuild preflight rejection does not become latent reconciliation authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-rebuild-inert-rejection-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    await assert.rejects(() => registry.rebuild(created.record.identity, {
      requestId: 'rejected-while-healthy', expectedPreviousIdentity: created.record.identity,
    }), /requires missing or invalid/u);
    loseSystemStorage(fake, created.record.identity, 'absent');
    const reconciled = await registry.reconcile();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].record.identity, created.record.identity);
    assert.equal(reconciled[0].record.generation, 1);
    assert.equal(fake.provisionCalls(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rebuild re-proves provider existence and ownership after quiesce before replacement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-rebuild-quiesce-proof-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    loseSystemStorage(fake, created.record.identity, 'absent');
    fake.instances.get(created.record.identity).state = 'running';
    fake.operations.quiesce = async (identity) => ({
      identity, exists: false, owned: false, compatible: false, state: 'absent', reason: 'provider object disappeared', storage: null, storageState: 'unknown',
    });
    await assert.rejects(() => registry.rebuild(created.record.identity, {
      requestId: 'quiesce-proof-rebuild', expectedPreviousIdentity: created.record.identity,
    }), /disappeared while quiescing/u);
    assert.equal(fake.provisionCalls(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rebuild retains the superseded generation even if it later appears compatible', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-rebuild-retention-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    loseSystemStorage(fake, created.record.identity, 'invalid');
    const provision = fake.operations.provision.bind(fake.operations);
    fake.operations.provision = async (input) => {
      const result = await provision(input);
      const superseded = fake.instances.get(created.record.identity);
      superseded.compatible = true;
      superseded.state = 'stopped';
      superseded.reason = null;
      superseded.storageState = 'present';
      superseded.storage = { identity: `storage-${created.record.identity}`, sourceIdentity: SOURCE, allocatedBytes: 4096 };
      return result;
    };
    const rebuilt = await registry.rebuild(created.record.identity, {
      requestId: 'retention-rebuild', expectedPreviousIdentity: created.record.identity,
    });
    assert.deepEqual(rebuilt.superseded, { identity: created.record.identity, cleanup: 'retained' });
    assert.equal(fake.instances.has(created.record.identity), true);
    assert.equal(fake.instances.has(rebuilt.record.identity), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('declared-image rebuild resumes one replacement through materialization and persistent owners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-rebuild-declared-image-'));
  const fake = fixture();
  try {
    let registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    const old = structuredClone(fake.instances.get(created.record.identity));
    const input = {
      environmentIdentity: `environment-${'1'.repeat(32)}`, operationId: 'lifecycle-declared-image', declarationRevision: 2,
      declaration: { profile: 'guest-a', image: { identity: TARGET, generation: '2026.09.1' } },
    };
    const state = {
      listEnvironments: () => registry.list(),
      ensureEnvironment: (value) => registry.ensure(value),
      rebuildEnvironment: (identity, options) => registry.rebuild(identity, options),
    };
    const subject = { resolve: async () => request().subject };
    const observe = createEnvironmentMaterialization({ state, subject, settings: { resolve: async () => request().settings } });
    assert.equal(environmentObservationCondition(await observe.observe(input)), 'system-storage-invalid');
    const materialization = createEnvironmentRebuildMaterialization({ state, subject, journal: { current: async () => ({
      operation: 'rebuild', operationId: input.operationId, declarationRevision: 2,
      entries: [{ stage: 'pre-observation', implementationGeneration: created.record.identity }, { stage: 'fenced-attempt' }],
    }) } });
    // Reconstruction must depend on the desired image, even if the old base is no longer available.
    fake.sources.delete(SOURCE);
    fake.failNextProvision();
    await assert.rejects(() => materialization.ensure(input), /simulated interruption/u);
    assert.equal(fake.instances.size, 2);
    registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    assert.equal((await registry.reconcile())[0].record.identity, created.record.identity);
    const result = await materialization.ensure(input);
    assert.equal(result.ready, true);
    assert.notEqual(result.implementationGeneration, created.record.identity);
    assert.deepEqual(result.superseded, { identity: created.record.identity, cleanup: 'retained' });
    assert.deepEqual(fake.instances.get(created.record.identity), old);
    const current = (await registry.list())[0];
    assert.equal(current.record.generation, 2);
    assert.equal(current.record.source.identity, TARGET);
    assert.equal(current.observation.storage.sourceIdentity, TARGET);
    assert.equal((await observe.observe(input)).systemStorage, 'present');
    assert.equal((await materialization.ensure(input)).implementationGeneration, result.implementationGeneration);
    assert.equal(fake.provisionCalls(), 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pending declared-image rebuild refuses retargeting and target lineage drift across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-rebuild-target-drift-'));
  const fake = fixture();
  try {
    let registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    const options = { requestId: 'target-drift', expectedPreviousIdentity: created.record.identity, sourceIdentity: TARGET };
    fake.failNextProvision();
    await assert.rejects(() => registry.rebuild(created.record.identity, options), /simulated interruption/u);
    registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    await assert.rejects(() => registry.rebuild(created.record.identity, { ...options, sourceIdentity: SOURCE }), /target source changed/u);
    const target = structuredClone(fake.sources.get(TARGET));
    for (const changed of [{ digest: 'c'.repeat(64) }, { revision: '2026.09.2' }, { profile: 'guest-b' }]) {
      fake.sources.set(TARGET, { ...target, ...changed });
      await assert.rejects(() => registry.rebuild(created.record.identity, options), /source lineage changed|source profile/u);
    }
    fake.sources.delete(TARGET);
    await assert.rejects(() => registry.rebuild(created.record.identity, options), /source absent/u);
    assert.equal((await registry.list())[0].record.identity, created.record.identity);
    assert.equal(fake.provisionCalls(), 2);
    fake.sources.set(TARGET, target);
    const result = await registry.rebuild(created.record.identity, options);
    await assert.rejects(() => registry.rebuild(result.record.identity, { ...options, sourceIdentity: SOURCE }), /target source changed/u);
    assert.equal(result.record.source.identity, TARGET);
    assert.equal(fake.provisionCalls(), 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('declared-image rebuild rejects unknown, foreign, missing, or unexplained existing storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-rebuild-target-guards-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    const old = structuredClone(fake.instances.get(created.record.identity));
    const options = { requestId: 'target-guards', expectedPreviousIdentity: created.record.identity, sourceIdentity: TARGET };
    for (const changed of [
      { owned: false }, { exists: false }, { compatible: false, storageState: 'unknown', storage: null },
      { storage: { ...old.storage, sourceIdentity: TARGET } },
      { storage: { ...old.storage, sourceIdentity: 'img-unexplained' } },
    ]) {
      fake.instances.set(created.record.identity, { ...old, ...changed });
      await assert.rejects(() => registry.rebuild(created.record.identity, options), /ownership|implementation is missing|requires missing or invalid|writable lineage/u);
    }
    fake.instances.set(created.record.identity, { ...old, state: 'running' });
    let quiesces = 0;
    fake.operations.quiesce = async (identity) => { quiesces += 1; return { ...old, identity }; };
    fake.sources.get(TARGET).profile = 'guest-b';
    await assert.rejects(() => registry.rebuild(created.record.identity, options), /source profile/u);
    fake.sources.delete(TARGET);
    await assert.rejects(() => registry.rebuild(created.record.identity, options), /source absent/u);
    await assert.rejects(() => registry.rebuild(created.record.identity, { ...options, sourceIdentity: '../image' }), /source identity is invalid/u);
    assert.equal(quiesces, 0);
    assert.equal(fake.provisionCalls(), 1);
    assert.equal((await registry.reconcile())[0].record.generation, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('declared-image rebuild rechecks old lineage after quiescing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-rebuild-target-quiesce-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    const old = fake.instances.get(created.record.identity);
    old.state = 'running';
    fake.operations.quiesce = async () => ({ ...old, state: 'stopped', storage: { ...old.storage, sourceIdentity: 'img-unexplained' } });
    await assert.rejects(() => registry.rebuild(created.record.identity, {
      requestId: 'target-quiesce', expectedPreviousIdentity: created.record.identity, sourceIdentity: TARGET,
    }), /writable lineage/u);
    assert.equal(fake.provisionCalls(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
