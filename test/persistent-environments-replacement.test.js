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
      if (failAfterProvision) { failAfterProvision = false; throw new Error('simulated interruption after replacement provider effect'); }
      return structuredClone(instances.get(identity));
    },
    async observe(identity) { return structuredClone(instances.get(identity) ?? absent(identity)); },
    async start(identity) { instances.get(identity).state = 'running'; return structuredClone(instances.get(identity)); },
    async stop(identity) { instances.get(identity).state = 'stopped'; return structuredClone(instances.get(identity)); },
    async drop(identity) { dropCalls += 1; const removed = instances.delete(identity); return { identity, removed, absent: !removed }; },
  };
  return {
    source, operations, instances,
    failNextProvision() { failAfterProvision = true; },
    provisionCalls() { return provisionCalls; },
    dropCalls() { return dropCalls; },
  };
}

function request() {
  return { subject: 'immutable-subject-42', profile: 'guest-a', sourceIdentity: SOURCE, settings: { memoryBytes: 2147483648, processorCount: 2, firmware: 'efi' } };
}

test('request-bound replacement retains the exact superseded generation until explicit retirement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-replacement-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    const replaced = await registry.replace(created.record.identity, {
      requestId: 'lifecycle-reset-1',
      expectedPreviousIdentity: created.record.identity,
    });
    assert.equal(replaced.record.generation, 2);
    assert.notEqual(replaced.record.identity, created.record.identity);
    assert.deepEqual(replaced.superseded, { identity: created.record.identity, cleanup: 'retained' });
    assert.equal(fake.instances.has(created.record.identity), true);
    assert.equal(fake.instances.has(replaced.record.identity), true);
    assert.equal(fake.dropCalls(), 0);

    const replayed = await registry.replace(replaced.record.identity, {
      requestId: 'lifecycle-reset-1',
      expectedPreviousIdentity: created.record.identity,
    });
    assert.equal(replayed.record.identity, replaced.record.identity);
    assert.equal(fake.provisionCalls(), 2);
    assert.equal(fake.dropCalls(), 0);

    const retired = await registry.retireSuperseded(replaced.record.identity, { supersededIdentity: created.record.identity });
    assert.equal(retired.identity, created.record.identity);
    assert.equal(retired.removed, true);
    assert.equal(fake.instances.has(created.record.identity), false);
    assert.equal(fake.instances.has(replaced.record.identity), true);
    assert.equal(fake.dropCalls(), 1);

    const repeatedRetirement = await registry.retireSuperseded(replaced.record.identity, { supersededIdentity: created.record.identity });
    assert.equal(repeatedRetirement.absent, true);
    assert.equal(fake.dropCalls(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted replacement waits for the outer lifecycle owner, then reconciles the same planned generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-replacement-reconcile-'));
  const fake = fixture();
  try {
    let registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    fake.failNextProvision();
    await assert.rejects(() => registry.replace(created.record.identity, {
      requestId: 'lifecycle-reset-2',
      expectedPreviousIdentity: created.record.identity,
    }), /simulated interruption/u);
    assert.equal(fake.instances.size, 2);

    registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const generic = await registry.reconcile();
    assert.equal(generic.length, 1);
    assert.equal(generic[0].record.generation, 1);
    assert.equal(generic[0].record.identity, created.record.identity);
    assert.equal(fake.provisionCalls(), 2);
    assert.equal(fake.dropCalls(), 0);

    const reconciled = await registry.replace(created.record.identity, {
      requestId: 'lifecycle-reset-2',
      expectedPreviousIdentity: created.record.identity,
    });
    assert.equal(reconciled.record.generation, 2);
    assert.notEqual(reconciled.record.identity, created.record.identity);
    assert.equal(fake.provisionCalls(), 2);
    assert.equal(fake.dropCalls(), 0);
    assert.equal(fake.instances.has(created.record.identity), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retirement rejects foreign or non-history subjects and never broadens deletion authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-replacement-retire-guards-'));
  const fake = fixture();
  try {
    const registry = new PersistentEnvironments({ directory: root, source: fake.source, operations: fake.operations });
    const created = await registry.ensure(request());
    const replaced = await registry.replace(created.record.identity, {
      requestId: 'lifecycle-reset-3',
      expectedPreviousIdentity: created.record.identity,
    });
    await assert.rejects(() => registry.retireSuperseded(replaced.record.identity, { supersededIdentity: `env-${'f'.repeat(32)}` }), /exact superseded/u);
    assert.equal(fake.dropCalls(), 0);

    fake.instances.get(created.record.identity).owned = false;
    await assert.rejects(() => registry.retireSuperseded(replaced.record.identity, { supersededIdentity: created.record.identity }), /ownership/u);
    assert.equal(fake.dropCalls(), 0);
    assert.equal(fake.instances.has(created.record.identity), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
