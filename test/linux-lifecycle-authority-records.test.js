import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createLinuxLifecycleAuthorityPlan,
} from '../src/setup/linux-lifecycle-authority.js';
import {
  createLinuxLifecycleAuthorityRecordStore,
  initialLinuxLifecycleAuthorityOwnershipRecord,
  LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
  normalizeLinuxLifecycleAuthorityOwnershipRecord,
} from '../src/setup/linux-lifecycle-authority-records.js';
import {
  normalizeProtectedAuthorityReconciliationJournal,
  PROTECTED_AUTHORITY_RECONCILIATION_JOURNAL_PROTOCOL,
} from '../src/setup/protected-authority-reconciliation.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function plan() {
  return createLinuxLifecycleAuthorityPlan({
    stateDirectory: '/home/alice/.devbridge/state',
    operatorName: 'alice',
    managementGroup: Object.freeze({ name: 'provider-control', id: 992 }),
  });
}

function journal(overrides = {}) {
  return {
    protocol: PROTECTED_AUTHORITY_RECONCILIATION_JOURNAL_PROTOCOL,
    transactionId: 'c'.repeat(64),
    candidateGeneration: A,
    previousGeneration: null,
    phase: 'observed',
    pending: null,
    outcome: 'in-progress',
    reason: null,
    ...overrides,
  };
}

function fixture({ protectedRoot = false, foreignName = null, pending = false, linkedOwnership = false } = {}) {
  const selected = plan();
  const entries = new Map();
  const calls = [];
  let admissions = 0;
  entries.set(selected.storage.parentDirectory, { kind: 'directory', uid: 0, gid: 0, mode: 0o755 });
  if (protectedRoot) {
    entries.set(selected.storage.rootDirectory, { kind: 'directory', uid: 0, gid: 0, mode: 0o755 });
    entries.set(selected.protectedRoot, { kind: 'directory', uid: 0, gid: 0, mode: 0o755 });
  }
  if (foreignName != null) entries.set(path.posix.join(selected.protectedRoot, foreignName), { kind: 'file', uid: 0, gid: 0, mode: 0o600, content: Buffer.from('foreign') });
  if (pending) entries.set(`${selected.ownershipManifest}.devbridge-pending`, { kind: 'file', uid: 0, gid: 0, mode: 0o444, content: Buffer.from('{}') });
  if (linkedOwnership) entries.set(selected.ownershipManifest, { kind: 'link', uid: 0, gid: 0, mode: 0o777, content: Buffer.from('{}') });

  const inspect = async ({ contract, kind }) => {
    const entry = entries.get(contract.path) ?? null;
    return Object.freeze({
      exists: entry != null,
      kind: entry?.kind === kind,
      owner: entry?.uid === contract.ownerId,
      group: entry?.gid === contract.groupId,
      mode: entry != null && (contract.mode == null ? (entry.mode & 0o022) === 0 : entry.mode === contract.mode),
      observedMode: entry?.mode ?? null,
    });
  };
  const ensureDirectory = async ({ contract, parent }) => {
    calls.push(['directory', contract.path]);
    const parentEntry = entries.get(parent.path);
    if (parentEntry?.kind !== 'directory' || parentEntry.uid !== parent.ownerId || parentEntry.gid !== parent.groupId) throw new Error('fake parent is invalid');
    const current = entries.get(contract.path);
    if (current != null && (current.kind !== 'directory' || current.uid !== contract.ownerId || current.gid !== contract.groupId)) throw new Error('fake directory is foreign');
    entries.set(contract.path, { kind: 'directory', uid: contract.ownerId, gid: contract.groupId, mode: contract.mode });
    return Object.freeze({ exists: true, kind: true, owner: true, group: true, mode: true, changed: current == null });
  };
  const load = async ({ contract }) => {
    const entry = entries.get(contract.path);
    if (entry?.kind !== 'file') throw new Error('fake file is unavailable');
    return Object.freeze({ content: Buffer.from(entry.content), size: entry.content.length });
  };
  const save = async ({ contract, parent, content }) => {
    calls.push(['file', contract.path, Buffer.from(content).toString('utf8')]);
    const parentEntry = entries.get(parent.path);
    if (parentEntry?.kind !== 'directory' || parentEntry.uid !== parent.ownerId || parentEntry.gid !== parent.groupId || parentEntry.mode !== parent.mode) throw new Error('fake record parent is invalid');
    entries.delete(`${contract.path}.devbridge-pending`);
    entries.set(contract.path, { kind: 'file', uid: contract.ownerId, gid: contract.groupId, mode: contract.mode, content: Buffer.from(content) });
    return Object.freeze({ exists: true, kind: true, owner: true, group: true, mode: true, changed: true });
  };
  const listDirectory = async (target) => [...entries.keys()]
    .filter((entry) => path.posix.dirname(entry) === target)
    .map((entry) => path.posix.basename(entry));
  const makeStore = ({ admit = true } = {}) => createLinuxLifecycleAuthorityRecordStore({
    plan: selected,
    admitClaim: async () => {
      admissions += 1;
      return admit;
    },
    normalizeTransaction: normalizeProtectedAuthorityReconciliationJournal,
  }, { inspect, ensureDirectory, load, save, listDirectory });
  return { selected, entries, calls, makeStore, admissions: () => admissions };
}

test('absent lifecycle records are read-only and do not create or admit a claim', async () => {
  const values = fixture();
  const store = values.makeStore();
  assert.equal(await store.ownership.load(), null);
  assert.equal(await store.journal.load(), null);
  assert.equal(values.admissions(), 0);
  assert.deepEqual(values.calls, []);
});

test('claim establishment is explicit and idempotent without creating a transaction', async () => {
  const values = fixture();
  const store = values.makeStore();
  const expected = initialLinuxLifecycleAuthorityOwnershipRecord(values.selected);

  assert.deepEqual(await store.claim.ensure(), expected);
  assert.equal(values.admissions(), 1);
  assert.deepEqual(values.calls.map((entry) => entry.slice(0, 2)), [
    ['directory', values.selected.storage.rootDirectory],
    ['directory', values.selected.protectedRoot],
    ['file', values.selected.ownershipManifest],
  ]);
  assert.equal(await store.journal.load(), null);

  const before = values.calls.length;
  assert.deepEqual(await store.claim.ensure(), expected);
  assert.equal(values.admissions(), 1);
  assert.equal(values.calls.length, before);
});

test('first transaction save admits and persists the exact claim before the transaction', async () => {
  const values = fixture();
  const store = values.makeStore();
  const saved = await store.journal.save(journal());
  assert.deepEqual(saved, normalizeProtectedAuthorityReconciliationJournal(journal()));
  assert.equal(values.admissions(), 1);
  assert.deepEqual(values.calls.map((entry) => entry.slice(0, 2)), [
    ['directory', values.selected.storage.rootDirectory],
    ['directory', values.selected.protectedRoot],
    ['file', values.selected.ownershipManifest],
    ['file', values.selected.refreshJournal],
  ]);
  const ownership = await store.ownership.load();
  assert.equal(ownership.protocol, LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL);
  assert.deepEqual(ownership, initialLinuxLifecycleAuthorityOwnershipRecord(values.selected));
  assert.deepEqual(await store.journal.load(), saved);
  assert.equal(values.entries.get(values.selected.ownershipManifest).mode, 0o444);
  assert.equal(values.entries.get(values.selected.refreshJournal).mode, 0o600);
  assert.equal(values.entries.get(values.selected.refreshJournal).content.at(-1), 0x0a);
});

test('claim denial and foreign unclaimed contents fail before mutation', async () => {
  const denied = fixture();
  await assert.rejects(() => denied.makeStore({ admit: false }).journal.save(journal()), /claim was not admitted/u);
  assert.equal(denied.admissions(), 1);
  assert.deepEqual(denied.calls, []);

  const foreign = fixture({ protectedRoot: true, foreignName: 'unexpected' });
  await assert.rejects(() => foreign.makeStore().journal.save(journal()), /contains foreign state/u);
  assert.equal(foreign.admissions(), 0);
  assert.deepEqual(foreign.calls, []);
});

test('the deterministic owned pending claim is recoverable but linked ownership is rejected', async () => {
  const interrupted = fixture({ protectedRoot: true, pending: true });
  await interrupted.makeStore().journal.save(journal());
  assert.equal(interrupted.entries.has(`${interrupted.selected.ownershipManifest}.devbridge-pending`), false);
  assert.equal(interrupted.entries.has(interrupted.selected.ownershipManifest), true);

  const linked = fixture({ protectedRoot: true, linkedOwnership: true });
  await assert.rejects(() => linked.makeStore().ownership.load(), /file policy is invalid/u);
  assert.equal(linked.admissions(), 0);
  assert.deepEqual(linked.calls, []);
});

test('an established claim resumes without admission and numeric identity cannot be rebound', async () => {
  const values = fixture();
  const initial = values.makeStore();
  await initial.journal.save(journal());
  const admitted = values.admissions();
  const resumed = values.makeStore({ admit: false });
  const bound = {
    ...initialLinuxLifecycleAuthorityOwnershipRecord(values.selected),
    localIdentity: { serviceUid: 995, operatorUid: 1000, readGid: 994, coordinationGid: 993, managementGid: 992 },
  };
  assert.deepEqual((await resumed.ownership.save(bound)).localIdentity, bound.localIdentity);
  assert.equal(values.admissions(), admitted);
  const before = values.calls.length;
  await assert.rejects(() => resumed.ownership.save({
    ...bound,
    localIdentity: { ...bound.localIdentity, serviceUid: 996 },
  }), /numeric identity binding is immutable/u);
  assert.equal(values.calls.length, before);
});

test('invalid transaction data is rejected before a claim or filesystem mutation', async () => {
  const values = fixture();
  await assert.rejects(() => values.makeStore().journal.save({}), /journal|transaction/u);
  assert.equal(values.admissions(), 0);
  assert.deepEqual(values.calls, []);
});

test('record persistence remains isolated from identity, service, provider, and reconciliation effects', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-lifecycle-authority-records.js', import.meta.url)), 'utf8');
  for (const forbidden of ['systemctl', 'useradd', 'groupadd', 'usermod', 'libvirt', 'virsh', 'qemu', 'polkit', 'reconcileProtectedAuthority', 'repository']) {
    assert.equal(source.includes(forbidden), false, `record persistence gained neighboring authority through ${forbidden}`);
  }
  assert.equal(source.includes('normalizeTransaction'), true);
});

test('ownership schema rejects root identities, generation aliasing, and foreign installation data', () => {
  const selected = plan();
  const initial = initialLinuxLifecycleAuthorityOwnershipRecord(selected);
  assert.throws(() => createLinuxLifecycleAuthorityRecordStore({
    plan: selected,
    admitClaim: async () => true,
    normalizeTransaction: null,
  }), /ports are invalid/u);
  assert.throws(() => normalizeLinuxLifecycleAuthorityOwnershipRecord({ ...initial, authorityIdentity: B }, selected), /does not match this installation/u);
  assert.throws(() => normalizeLinuxLifecycleAuthorityOwnershipRecord({ ...initial, managementGid: 991 }, selected), /does not match this installation/u);
  assert.throws(() => normalizeLinuxLifecycleAuthorityOwnershipRecord({
    ...initial,
    localIdentity: { serviceUid: 0, operatorUid: 1000, readGid: 994, coordinationGid: 993, managementGid: 992 },
  }, selected), /service uid is invalid/u);
  assert.throws(() => normalizeLinuxLifecycleAuthorityOwnershipRecord({
    ...initial,
    localIdentity: { serviceUid: 995, operatorUid: 1000, readGid: 994, coordinationGid: 993, managementGid: 991 },
  }, selected), /required group changed/u);
  assert.throws(() => normalizeLinuxLifecycleAuthorityOwnershipRecord({
    ...initial,
    activeGeneration: A,
    stagedGeneration: A,
  }, selected), /aliases another state/u);
});
