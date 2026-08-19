import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskLeaseLostError } from '../src/errors.js';
import { loadOrCreateAgentIdentity } from '../src/security/agent-identity.js';
import { TaskLeaseManager } from '../src/run/task-lease-manager.js';
import { signTaskLease } from '../src/run/task-lease.js';

const REVISION = 'a'.repeat(64);
const TASK = { queueRepository: 'iteathen/PATCH-POLLER', issueNumber: 49, revision: REVISION };
const TTL = 120_000;

class MemoryLeaseStore {
  constructor(current = null) {
    this.current = current;
    this.calls = [];
    this.counter = 1;
    this.loseNextTo = null;
    this.throwNext = null;
  }

  async observe() { return this.current ?? { commitSha: null, envelope: null }; }

  async compareAndSwap(_task, { expectedSha, envelope }) {
    this.calls.push({ expectedSha, envelope });
    if (this.throwNext) {
      const error = this.throwNext;
      this.throwNext = null;
      throw error;
    }
    if (this.loseNextTo) {
      this.current = this.loseNextTo;
      this.loseNextTo = null;
      return { updated: false, reason: 'cas-lost', current: this.current };
    }
    const observed = this.current?.commitSha ?? null;
    if (observed !== expectedSha) return { updated: false, reason: 'cas-lost', current: this.current };
    const commitSha = this.counter.toString(16).padStart(40, '0');
    this.counter += 1;
    this.current = { commitSha, envelope };
    return { updated: true, commitSha, envelope };
  }
}

function remoteLease(identity, { now, expires = now + TTL, epoch = 1, previousLeaseSha = null, state = 'active', sessionId = '9'.repeat(32) } = {}) {
  return signTaskLease(identity, {
    queueRepository: TASK.queueRepository,
    issueNumber: TASK.issueNumber,
    taskRevision: TASK.revision,
    sessionId,
    epoch,
    state,
    issuedAt: new Date(now).toISOString(),
    expiresAt: state === 'active' ? new Date(expires).toISOString() : null,
    previousLeaseSha,
  });
}

function managerOptions(identity, store, trusted, clock, extra = {}) {
  return {
    identity,
    trustedIdentities: trusted,
    store,
    leaseTtlMs: TTL,
    heartbeatIntervalMs: 30_000,
    clockSkewMs: 5_000,
    nowMs: () => clock.now,
    setIntervalFn: () => ({ fake: true }),
    clearIntervalFn: () => {},
    sessionId: '1'.repeat(32),
    ...extra,
  };
}

test('task lease acquisition, renewal, and release advance an exact predecessor chain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-manager-'));
  try {
    const identity = await loadOrCreateAgentIdentity({ directory: root, handle: 'agent-a' });
    const store = new MemoryLeaseStore();
    const clock = { now: Date.parse('2026-08-19T03:00:00.000Z') };
    const manager = new TaskLeaseManager(managerOptions(identity, store, new Map(), clock));
    const acquired = await manager.begin(TASK);
    assert.equal(acquired.acquired, true);
    const handle = acquired.handle;
    assert.equal(handle.epoch, 1);
    assert.equal(store.calls[0].expectedSha, null);
    assert.equal(store.calls[0].envelope.subject.previousLeaseSha, null);

    clock.now += 30_000;
    const renewed = await manager.renew(handle);
    assert.equal(renewed.renewed, true);
    assert.equal(handle.epoch, 2);
    assert.equal(store.calls[1].expectedSha, '0'.repeat(39) + '1');
    assert.equal(store.calls[1].envelope.subject.previousLeaseSha, store.calls[1].expectedSha);

    clock.now += 1_000;
    const released = await manager.release(handle);
    assert.equal(released.released, true);
    assert.equal(store.current.envelope.subject.state, 'released');
    assert.equal(store.current.envelope.subject.expiresAt, null);
    assert.equal(store.current.envelope.subject.previousLeaseSha, '0'.repeat(39) + '2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unexpired trusted peer lease defers while expired peer lease can be reclaimed after skew', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-peer-'));
  const peerRoot = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-peer-other-'));
  try {
    const identity = await loadOrCreateAgentIdentity({ directory: root, handle: 'agent-a' });
    const peer = await loadOrCreateAgentIdentity({ directory: peerRoot, handle: 'agent-b' });
    const now = Date.parse('2026-08-19T03:00:00.000Z');
    const clock = { now };
    const trusted = new Map([[peer.fingerprint, peer]]);
    const active = { commitSha: 'a'.repeat(40), envelope: remoteLease(peer, { now: now - 10_000, expires: now + 60_000 }) };
    const store = new MemoryLeaseStore(active);
    const manager = new TaskLeaseManager(managerOptions(identity, store, trusted, clock));

    const deferred = await manager.begin(TASK);
    assert.equal(deferred.acquired, false);
    assert.equal(deferred.reason, 'held-by-peer');
    assert.equal(deferred.ownerAddress, peer.address);
    assert.equal(store.calls.length, 0);

    store.current = { commitSha: 'b'.repeat(40), envelope: remoteLease(peer, { now: now - TTL, expires: now - 6_000, epoch: 4 }) };
    const reclaimed = await manager.begin(TASK);
    assert.equal(reclaimed.acquired, true);
    assert.equal(store.calls.at(-1).expectedSha, 'b'.repeat(40));
    assert.equal(store.calls.at(-1).envelope.subject.epoch, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(peerRoot, { recursive: true, force: true });
  }
});

test('same persistent identity takeover requires a locally exclusive control session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-restart-'));
  try {
    const identity = await loadOrCreateAgentIdentity({ directory: root, handle: 'agent-a' });
    const now = Date.parse('2026-08-19T03:00:00.000Z');
    const previous = { commitSha: 'c'.repeat(40), envelope: remoteLease(identity, { now: now - 10_000, expires: now + 60_000, epoch: 7, sessionId: '8'.repeat(32) }) };
    const store = new MemoryLeaseStore(previous);
    const clock = { now };

    const ordinary = new TaskLeaseManager(managerOptions(identity, store, new Map(), clock));
    const deferred = await ordinary.begin(TASK);
    assert.equal(deferred.acquired, false);
    assert.equal(deferred.reason, 'held-by-local-session');
    assert.equal(store.calls.length, 0);

    const exclusive = new TaskLeaseManager(managerOptions(identity, store, new Map(), clock, { allowIdentityTakeover: true }));
    const acquired = await exclusive.begin(TASK);
    assert.equal(acquired.acquired, true);
    assert.equal(acquired.reconciled, true);
    assert.equal(acquired.handle.epoch, 8);
    assert.equal(store.calls[0].expectedSha, previous.commitSha);
    assert.equal(store.calls[0].envelope.subject.sessionId, '1'.repeat(32));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('definite renewal CAS loss fences and aborts the stale local holder', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-fence-'));
  const peerRoot = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-fence-peer-'));
  try {
    const identity = await loadOrCreateAgentIdentity({ directory: root, handle: 'agent-a' });
    const peer = await loadOrCreateAgentIdentity({ directory: peerRoot, handle: 'agent-b' });
    const clock = { now: Date.parse('2026-08-19T03:00:00.000Z') };
    const store = new MemoryLeaseStore();
    const manager = new TaskLeaseManager(managerOptions(identity, store, new Map([[peer.fingerprint, peer]]), clock));
    const { handle } = await manager.begin(TASK);
    const competitor = {
      commitSha: 'f'.repeat(40),
      envelope: remoteLease(peer, { now: clock.now, expires: clock.now + TTL, epoch: handle.epoch + 1, previousLeaseSha: handle.commitSha }),
    };
    store.loseNextTo = competitor;
    const result = await manager.renew(handle);
    assert.equal(result.renewed, false);
    assert.equal(handle.signal.aborted, true);
    assert.equal(handle.signal.reason instanceof TaskLeaseLostError, true);
    assert.throws(() => manager.assertOwned(handle), TaskLeaseLostError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(peerRoot, { recursive: true, force: true });
  }
});

test('ambiguous renewal failure keeps the claim only until its signed expiry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-ambiguous-'));
  try {
    const identity = await loadOrCreateAgentIdentity({ directory: root, handle: 'agent-a' });
    const clock = { now: Date.parse('2026-08-19T03:00:00.000Z') };
    const store = new MemoryLeaseStore();
    const manager = new TaskLeaseManager(managerOptions(identity, store, new Map(), clock));
    const { handle } = await manager.begin(TASK);
    store.throwNext = new Error('network unavailable');
    await assert.rejects(manager.renew(handle), /network unavailable/u);
    assert.equal(handle.signal.aborted, false);
    manager.assertOwned(handle);

    clock.now = Date.parse(handle.expiresAt) + 1;
    assert.throws(() => manager.assertOwned(handle), TaskLeaseLostError);
    assert.equal(handle.signal.aborted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown or overlong peer lease fails closed instead of being overwritten', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-unknown-'));
  const peerRoot = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-unknown-peer-'));
  try {
    const identity = await loadOrCreateAgentIdentity({ directory: root, handle: 'agent-a' });
    const peer = await loadOrCreateAgentIdentity({ directory: peerRoot, handle: 'agent-b' });
    const now = Date.parse('2026-08-19T03:00:00.000Z');
    const clock = { now };
    const store = new MemoryLeaseStore({ commitSha: 'a'.repeat(40), envelope: remoteLease(peer, { now, expires: now + TTL }) });
    const manager = new TaskLeaseManager(managerOptions(identity, store, new Map(), clock));
    await assert.rejects(manager.begin(TASK), /not a locally trusted peer/u);
    assert.equal(store.calls.length, 0);

    const trusted = new TaskLeaseManager(managerOptions(identity, store, new Map([[peer.fingerprint, peer]]), clock));
    store.current = { commitSha: 'b'.repeat(40), envelope: remoteLease(peer, { now, expires: now + TTL + 1 }) };
    await assert.rejects(trusted.begin(TASK), /duration exceeds local coordination policy/u);
    assert.equal(store.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(peerRoot, { recursive: true, force: true });
  }
});
