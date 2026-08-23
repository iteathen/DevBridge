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
  let dropCalls = 0;
  let stopCalls = 0;
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
      if (failAfterProvision) { failAfterProvision = false; throw new Error('simulated interruption after recreate provider effect'); }
      return structuredClone(instances.get(identity));
    },
    async observe(identity) { return structuredClone(instances.get(identity) ?? absent(identity)); },
    async start(identity) { instances.get(identity).state = 'running'; return structuredClone(instances.get(identity)); },
    async stop(identity) { stopCalls += 1; instances.get(identity).state = 'stopped'; return structuredClone(instances.get(identity)); },
    async drop(identity) { dropCalls += 1; const removed = instances.delete(identity); return { identity, removed, absent: !removed }; },
  };
  return {
    source, operations, instances,
    failNextProvision() { failAfterProvision = true; },
    provisionCalls: () => provisionCalls,
    dropCalls: () => dropCalls,
    stopCalls: () => stopCalls,
  };
}
function request() {
  return { subject: 'immutable-subject-42', profile: 'guest-a', sourceIdentity: SOURCE, settings: { memoryBytes: 2147483648, processorCount: 2, firmware: 'efi' } };
}

test('recreate advances the generation when the registered provider object is already missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-recreate-missing-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    fake.instances.delete(created.record.identity);
    const recreated = await registry.recreate(created.record.identity, {
      requestId: 'lifecycle-recreate-1', expectedPreviousIdentity: created.record.identity,
    });
    assert.equal(recreated.record.generation, 2);
    assert.notEqual(recreated.record.identity, created.record.identity);
    assert.deepEqual(recreated.superseded, { identity: created.record.identity, cleanup: 'absent' });
    assert.equal(fake.instances.has(recreated.record.identity), true);
    assert.equal(fake.stopCalls(), 0);
    assert.equal(fake.dropCalls(), 0);

    const retirement = await registry.retireSuperseded(recreated.record.identity, { supersededIdentity: created.record.identity });
    assert.equal(retirement.absent, true);
    assert.equal(fake.dropCalls(), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recreate tolerates incompatible owned state but retains it until explicit post-verification retirement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-recreate-retain-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    fake.instances.get(created.record.identity).state = 'running';
    fake.instances.get(created.record.identity).compatible = false;
    fake.instances.get(created.record.identity).storageState = 'invalid';
    const recreated = await registry.recreate(created.record.identity, {
      requestId: 'lifecycle-recreate-2', expectedPreviousIdentity: created.record.identity,
    });
    assert.deepEqual(recreated.superseded, { identity: created.record.identity, cleanup: 'retained' });
    assert.equal(fake.instances.has(created.record.identity), true);
    assert.equal(fake.instances.get(created.record.identity).state, 'stopped');
    assert.equal(fake.stopCalls(), 1);
    assert.equal(fake.dropCalls(), 0);

    const retired = await registry.retireSuperseded(recreated.record.identity, { supersededIdentity: created.record.identity });
    assert.equal(retired.removed, true);
    assert.equal(fake.instances.has(created.record.identity), false);
    assert.equal(fake.dropCalls(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recreate refuses foreign provider ownership before provisioning or retirement authority can widen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-recreate-foreign-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    fake.instances.get(created.record.identity).owned = false;
    const beforeProvision = fake.provisionCalls();
    await assert.rejects(() => registry.recreate(created.record.identity, {
      requestId: 'lifecycle-recreate-3', expectedPreviousIdentity: created.record.identity,
    }), /ownership/u);
    assert.equal(fake.provisionCalls(), beforeProvision);
    assert.equal(fake.dropCalls(), 0);
    assert.equal(fake.instances.has(created.record.identity), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted recreate is not replayed by generic reconciliation and reuses the same planned generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-recreate-resume-'));
  const fake = fixture();
  try {
    let registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    fake.failNextProvision();
    await assert.rejects(() => registry.recreate(created.record.identity, {
      requestId: 'lifecycle-recreate-4', expectedPreviousIdentity: created.record.identity,
    }), /simulated interruption/u);
    assert.equal(fake.instances.size, 2);
    assert.equal(fake.provisionCalls(), 2);

    registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const generic = await registry.reconcile();
    assert.equal(generic[0].record.identity, created.record.identity);
    assert.equal(fake.provisionCalls(), 2);
    assert.equal(fake.dropCalls(), 0);

    const resumed = await registry.recreate(created.record.identity, {
      requestId: 'lifecycle-recreate-4', expectedPreviousIdentity: created.record.identity,
    });
    assert.equal(resumed.record.generation, 2);
    assert.equal(fake.provisionCalls(), 2);
    assert.equal(fake.instances.size, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
