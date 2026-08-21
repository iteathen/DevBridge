import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentLifecycleBusyError } from '../src/errors.js';
import { PersistentEnvironments } from '../src/runtime/persistent-environments.js';

const SOURCE_A = 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOURCE_B = 'img-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BINDING = '11111111111111111111111111111111';

function fixture() {
  const sources = new Map([
    [SOURCE_A, { identity: SOURCE_A, profile: 'guest-a', revision: '2026.08.1', digest: 'a'.repeat(64), handle: { token: 'a' } }],
    [SOURCE_B, { identity: SOURCE_B, profile: 'guest-a', revision: '2026.08.2', digest: 'b'.repeat(64), handle: { token: 'b' } }],
  ]);
  const instances = new Map();
  let failAfterProvision = false;
  let provisionCalls = 0;
  const operations = {
    async inspect() { return { identity: BINDING }; },
    async provision({ identity, source }) {
      assert.equal('profile' in source, false);
      provisionCalls += 1;
      const existing = instances.get(identity);
      if (existing && existing.storage.sourceIdentity !== source.identity) throw new Error('lineage mismatch');
      instances.set(identity, {
        identity, exists: true, owned: true, compatible: true, state: 'stopped', reason: null,
        storage: { identity: `storage-${identity}`, sourceIdentity: source.identity, allocatedBytes: 4096 },
      });
      if (failAfterProvision) { failAfterProvision = false; throw new Error('simulated interruption after provider effect'); }
      return structuredClone(instances.get(identity));
    },
    async observe(identity) {
      return structuredClone(instances.get(identity) ?? { identity, exists: false, owned: false, compatible: false, state: 'absent', reason: 'absent', storage: null });
    },
    async start(identity) { instances.get(identity).state = 'running'; return structuredClone(instances.get(identity)); },
    async stop(identity) { instances.get(identity).state = 'stopped'; return structuredClone(instances.get(identity)); },
    async drop(identity) { const removed = instances.delete(identity); return { identity, removed, absent: !removed }; },
  };
  const source = { async resolve(identity) { const value = sources.get(identity); if (!value) throw new Error('source absent'); return structuredClone(value); } };
  return {
    source, operations, instances, sources,
    failNextProvision() { failAfterProvision = true; },
    provisionCalls() { return provisionCalls; },
  };
}

function request(sourceIdentity = SOURCE_A) {
  return { subject: 'immutable-subject-42', profile: 'guest-a', sourceIdentity, settings: { memoryBytes: 2147483648, processorCount: 2, firmware: 'efi' } };
}

test('stable identity excludes display topology and rejects foreign request properties', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-registry-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const first = await registry.ensure(request());
    const second = await registry.ensure(request());
    assert.equal(second.record.identity, first.record.identity);
    assert.equal(second.record.subject, 'immutable-subject-42');
    await assert.rejects(() => registry.ensure({ ...request(), repository: 'owner/renamed-display' }), /repository is not allowed/u);
    await assert.rejects(() => registry.ensure({ ...request(), displayName: 'renamed-display' }), /displayName is not allowed/u);
    assert.equal(fake.instances.size, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source drift is rejected until explicit reseed and stale generation identities lose authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-reseed-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const first = await registry.ensure(request());
    await assert.rejects(() => registry.ensure(request(SOURCE_B)), /explicit reseed is required/u);
    const reseeded = await registry.reseed(first.record.identity, { sourceIdentity: SOURCE_B });
    assert.notEqual(reseeded.record.identity, first.record.identity);
    assert.equal(reseeded.record.generation, 2);
    assert.equal(reseeded.record.source.identity, SOURCE_B);
    assert.equal(fake.instances.has(first.record.identity), false);
    await assert.rejects(() => registry.start(first.record.identity), /stale/u);
    const reset = await registry.reset(reseeded.record.identity);
    assert.equal(reset.record.generation, 3);
    assert.equal(reset.record.source.identity, SOURCE_B);
    assert.notEqual(reset.record.identity, reseeded.record.identity);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registered source identity cannot be reused with changed lineage metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-source-metadata-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    await registry.ensure(request());
    fake.sources.get(SOURCE_A).revision = '2026.08.changed';
    await assert.rejects(() => registry.ensure(request()), /source lineage changed/u);
    assert.equal(fake.instances.size, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('command completion and daemon restart preserve one owned environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-restart-'));
  const fake = fixture();
  try {
    let registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    await registry.start(created.record.identity);
    await registry.stop(created.record.identity);
    registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const observed = await registry.observe(created.record.identity);
    assert.equal(observed.record.identity, created.record.identity);
    assert.equal(observed.observation.state, 'stopped');
    assert.equal(observed.observation.storage.sourceIdentity, SOURCE_A);
    assert.equal(fake.instances.size, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restart reconciles an ambiguous provision effect instead of allocating another identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-reconcile-'));
  const fake = fixture();
  try {
    fake.failNextProvision();
    let registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    await assert.rejects(() => registry.ensure(request()), /simulated interruption/u);
    assert.equal(fake.instances.size, 1);
    const effectIdentity = [...fake.instances.keys()][0];
    registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const reconciled = await registry.reconcile();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].record.identity, effectIdentity);
    assert.equal(fake.instances.size, 1);
    assert.equal(fake.provisionCalls(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restart reconciles an interrupted reseed without deleting the current generation first', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-reseed-reconcile-'));
  const fake = fixture();
  try {
    let registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    fake.failNextProvision();
    await assert.rejects(() => registry.reseed(created.record.identity, { sourceIdentity: SOURCE_B }), /simulated interruption/u);

    const identitiesAfterInterruption = [...fake.instances.keys()];
    assert.equal(identitiesAfterInterruption.includes(created.record.identity), true);
    assert.equal(identitiesAfterInterruption.length, 2);

    registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const protectedWhilePending = await registry.protectedSourceIdentities();
    assert.deepEqual(protectedWhilePending, [SOURCE_A, SOURCE_B]);
    const reconciled = await registry.reconcile();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].record.generation, 2);
    assert.equal(reconciled[0].record.source.identity, SOURCE_B);
    assert.equal(fake.instances.has(created.record.identity), false);
    assert.equal(fake.instances.size, 1);
    assert.equal(fake.provisionCalls(), 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lifecycle transitions reject a provider observation that reports the wrong backing identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-lineage-observe-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    fake.instances.get(created.record.identity).storage.sourceIdentity = SOURCE_B;
    await assert.rejects(() => registry.start(created.record.identity), /writable lineage does not match/u);
    assert.equal(fake.instances.get(created.record.identity).state, 'stopped');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent lifecycle mutations serialize and stale callers cannot rotate the replacement again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-concurrent-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    const results = await Promise.allSettled([registry.reset(created.record.identity), registry.reset(created.record.identity)]);
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(results.filter((entry) => entry.status === 'rejected').length, 1);
    assert.match(results.find((entry) => entry.status === 'rejected').reason.message, /stale/u);
    assert.equal(fake.instances.size, 1);
    const listed = await registry.list();
    assert.equal(listed[0].record.generation, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('attachment identity drift never silently adopts an environment created by another attachment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-binding-'));
  const fake = fixture();
  try {
    const first = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    await first.ensure(request());
    const foreignOperations = { ...fake.operations, async inspect() { return { identity: '22222222222222222222222222222222' }; } };
    const second = new PersistentEnvironments({ directory: root, source: fake.source, operations: foreignOperations });
    await assert.rejects(() => second.ensure(request()), /attachment identity changed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('separate registry instances cannot overlap one directory lifecycle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-exclusive-'));
  const fake = fixture();
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const delayedSource = {
    async resolve(identity) {
      enter();
      await blocked;
      return fake.source.resolve(identity);
    },
  };
  try {
    const first = new PersistentEnvironments({ directory: root, source: delayedSource, operations: fake.operations });
    const second = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const ensuring = first.ensure(request());
    await entered;
    await assert.rejects(
      () => second.ensure(request()),
      (error) => error instanceof EnvironmentLifecycleBusyError && error.code === 'DEVBRIDGE_ENVIRONMENT_LIFECYCLE_BUSY',
    );
    assert.equal(fake.provisionCalls(), 0);
    release();
    await ensuring;
    assert.equal(fake.provisionCalls(), 1);
  } finally {
    release?.();
    await rm(root, { recursive: true, force: true });
  }
});
