import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateAgentIdentity } from '../src/security/agent-identity.js';
import {
  TASK_LEASE_PROTOCOL,
  canonicalTaskLeaseSubject,
  parseSignedTaskLease,
  serializeSignedTaskLease,
  signTaskLease,
  taskLeaseExpired,
  verifySignedTaskLease,
} from '../src/run/task-lease.js';

const REVISION = 'a'.repeat(64);
const PREVIOUS = 'b'.repeat(40);

function activeSubject(overrides = {}) {
  return {
    protocol: TASK_LEASE_PROTOCOL,
    queueRepository: 'iteathen/PATCH-POLLER',
    issueNumber: 49,
    taskRevision: REVISION,
    sessionId: '1'.repeat(32),
    epoch: 3,
    state: 'active',
    issuedAt: '2026-08-19T02:40:00.000Z',
    expiresAt: '2026-08-19T03:00:00.000Z',
    previousLeaseSha: PREVIOUS,
    ...overrides,
  };
}

test('signed task lease verifies only for the exact trusted task subject', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-task-lease-'));
  try {
    const identity = await loadOrCreateAgentIdentity({ directory: root, handle: 'agent-a' });
    const envelope = signTaskLease(identity, activeSubject());
    const text = serializeSignedTaskLease(envelope);
    const parsed = parseSignedTaskLease(text);
    const trusted = new Map([[identity.fingerprint, identity]]);
    const verified = verifySignedTaskLease(parsed, {
      trustedIdentities: trusted,
      queueRepository: 'iteathen/PATCH-POLLER',
      issueNumber: 49,
      taskRevision: REVISION,
    });
    assert.equal(verified.subject.ownerFingerprint, identity.fingerprint);
    assert.equal(verified.subject.ownerAddress, identity.address);
    assert.equal(JSON.stringify(verified).includes('privateKeyPkcs8'), false);

    assert.throws(
      () => verifySignedTaskLease(parsed, {
        trustedIdentities: trusted,
        queueRepository: 'iteathen/PATCH-POLLER',
        issueNumber: 50,
        taskRevision: REVISION,
      }),
      /does not match the requested task revision/u,
    );
    assert.throws(
      () => verifySignedTaskLease(parsed, {
        trustedIdentities: new Map(),
        queueRepository: 'iteathen/PATCH-POLLER',
        issueNumber: 49,
        taskRevision: REVISION,
      }),
      /not a locally trusted peer/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('signature binds canonical lease bytes and rejects tampering', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-task-lease-tamper-'));
  try {
    const identity = await loadOrCreateAgentIdentity({ directory: root, handle: 'agent-a' });
    const envelope = signTaskLease(identity, activeSubject());
    const tampered = structuredClone(envelope);
    tampered.subject.epoch += 1;
    assert.throws(
      () => verifySignedTaskLease(tampered, {
        trustedIdentities: new Map([[identity.fingerprint, identity]]),
        queueRepository: 'iteathen/PATCH-POLLER',
        issueNumber: 49,
        taskRevision: REVISION,
      }),
      /signature verification failed/u,
    );

    const canonical = canonicalTaskLeaseSubject(envelope.subject);
    assert.equal(canonical, JSON.stringify(envelope.subject));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lease validation rejects authority ambiguity and malformed time/identity fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-task-lease-invalid-'));
  try {
    const identity = await loadOrCreateAgentIdentity({ directory: root, handle: 'agent-a' });
    assert.throws(
      () => signTaskLease(identity, activeSubject({ expiresAt: '2026-08-19T02:39:59.000Z' })),
      /expiry must be after issuance/u,
    );
    assert.throws(
      () => signTaskLease(identity, activeSubject({ taskRevision: 'ABC' })),
      /lowercase SHA-256 digest/u,
    );
    assert.throws(
      () => signTaskLease(identity, activeSubject({ epoch: 0 })),
      /positive safe integer/u,
    );
    assert.throws(
      () => signTaskLease(identity, activeSubject({ unexpectedAuthority: 'force' })),
      /unexpectedAuthority is not allowed/u,
    );
    assert.throws(
      () => signTaskLease(identity, activeSubject({ state: 'released', expiresAt: '2026-08-19T03:00:00.000Z' })),
      /released task lease expiresAt must be null/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lease expiry applies the configured skew margin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-task-lease-expiry-'));
  try {
    const identity = await loadOrCreateAgentIdentity({ directory: root, handle: 'agent-a' });
    const envelope = signTaskLease(identity, activeSubject());
    const expiry = Date.parse(envelope.subject.expiresAt);
    assert.equal(taskLeaseExpired(envelope.subject, expiry, 0), false);
    assert.equal(taskLeaseExpired(envelope.subject, expiry + 1, 0), true);
    assert.equal(taskLeaseExpired(envelope.subject, expiry + 30_000, 60_000), false);
    assert.equal(taskLeaseExpired(envelope.subject, expiry + 60_001, 60_000), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
