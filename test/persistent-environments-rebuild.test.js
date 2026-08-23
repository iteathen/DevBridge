import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PersistentEnvironments } from '../src/runtime/persistent-environments.js';

const SOURCE = 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BINDING = '11111111111111111111111111111111';

function fixture() {
  const instances = new Map();
  let failAfterProvision = false;
  let provisionCalls = 0;
  const source = {
    async resolve(identity) {
      if (identity !== SOURCE) throw new Error('source absent');
      return { identity: SOURCE, profile: 'guest-a', revision: '2026.08.1', digest: 'a'.repeat(64), handle: { token: 'a' } };
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
    source, operations, instances,
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
