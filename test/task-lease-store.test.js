import test from 'node:test';
import assert from 'node:assert/strict';
import { GitTaskLeaseStore } from '../src/git/task-lease-store.js';
import { SIGNED_TASK_LEASE_PROTOCOL, TASK_LEASE_PROTOCOL, serializeSignedTaskLease } from '../src/run/task-lease.js';

const REVISION = '1'.repeat(64);
const OWNER = '2'.repeat(64);
const TREE = 'a'.repeat(40);
const CREATED = 'b'.repeat(40);
const EXPECTED = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);

function task() {
  return { queueRepository: 'iteathen/PATCH-POLLER', issueNumber: 49, revision: REVISION };
}

function envelope({ previousLeaseSha = null, epoch = 1 } = {}) {
  return {
    protocol: SIGNED_TASK_LEASE_PROTOCOL,
    subject: {
      protocol: TASK_LEASE_PROTOCOL,
      queueRepository: 'iteathen/PATCH-POLLER',
      issueNumber: 49,
      taskRevision: REVISION,
      ownerFingerprint: OWNER,
      ownerAddress: `agent#${OWNER}`,
      sessionId: '3'.repeat(32),
      epoch,
      state: 'active',
      issuedAt: '2026-08-19T03:00:00.000Z',
      expiresAt: '2026-08-19T03:20:00.000Z',
      previousLeaseSha,
    },
    signature: Buffer.alloc(64, 7).toString('base64'),
  };
}

function workspace() {
  return {
    ensureRepository: async () => ({
      repository: 'iteathen/PATCH-POLLER',
      repoDir: '/control/repo',
      remoteUrl: 'https://github.com/iteathen/PATCH-POLLER.git',
      baseSha: 'e'.repeat(40),
    }),
  };
}

function success(stdout = '') {
  return { exitCode: 0, timedOut: false, stdout, stderr: '' };
}

test('first task lease acquisition uses explicit empty expected-value force-with-lease', async () => {
  const calls = [];
  const git = {
    async run(args, options) {
      calls.push({ args: [...args], options: { ...options } });
      if (args[0] === 'rev-parse') return success(`${TREE}\n`);
      if (args.includes('commit-tree')) return success(`${CREATED}\n`);
      if (args[0] === 'push') return success();
      throw new Error(`unexpected git call ${args.join(' ')}`);
    },
  };
  const store = new GitTaskLeaseStore({ workspaceManager: workspace(), gitClient: git, queueRepository: 'iteathen/PATCH-POLLER' });
  const result = await store.compareAndSwap(task(), { expectedSha: null, envelope: envelope() });
  assert.equal(result.updated, true);
  const push = calls.find((call) => call.args[0] === 'push');
  const ref = store.refForTask(task());
  assert.deepEqual(push.args, ['push', 'origin', `--force-with-lease=${ref}:`, `${CREATED}:${ref}`]);
  assert.equal(push.args.includes('--force'), false);
  const commit = calls.find((call) => call.args.includes('commit-tree'));
  assert.equal(commit.args.includes('-p'), false);
});

test('lease renewal parents the exact predecessor and CASes against the same SHA', async () => {
  const calls = [];
  const git = {
    async run(args) {
      calls.push([...args]);
      if (args[0] === 'rev-parse') return success(`${TREE}\n`);
      if (args.includes('commit-tree')) return success(`${CREATED}\n`);
      if (args[0] === 'push') return success();
      throw new Error(`unexpected git call ${args.join(' ')}`);
    },
  };
  const store = new GitTaskLeaseStore({ workspaceManager: workspace(), gitClient: git, queueRepository: 'iteathen/PATCH-POLLER' });
  await store.compareAndSwap(task(), { expectedSha: EXPECTED, envelope: envelope({ previousLeaseSha: EXPECTED, epoch: 2 }) });
  const ref = store.refForTask(task());
  const commit = calls.find((args) => args.includes('commit-tree'));
  assert.equal(commit[commit.indexOf('-p') + 1], EXPECTED);
  const push = calls.find((args) => args[0] === 'push');
  assert.deepEqual(push, ['push', 'origin', `--force-with-lease=${ref}:${EXPECTED}`, `${CREATED}:${ref}`]);
});

test('competing lease update is reported as CAS loss instead of overwritten', async () => {
  const currentEnvelope = envelope({ previousLeaseSha: null, epoch: 9 });
  const calls = [];
  const git = {
    async run(args) {
      calls.push([...args]);
      if (args[0] === 'rev-parse') return success(`${TREE}\n`);
      if (args.includes('commit-tree')) return success(`${CREATED}\n`);
      if (args[0] === 'push') return { exitCode: 1, timedOut: false, stdout: '', stderr: 'stale info' };
      if (args[0] === 'ls-remote') return success(`${OTHER}\t${args.at(-1)}\n`);
      if (args[0] === 'fetch') return success();
      if (args[0] === 'cat-file') return success();
      if (args[0] === 'show' && args.includes('--format=%B')) return success(serializeSignedTaskLease(currentEnvelope));
      if (args[0] === 'show' && args.includes('--format=%P')) return success('\n');
      throw new Error(`unexpected git call ${args.join(' ')}`);
    },
  };
  const store = new GitTaskLeaseStore({ workspaceManager: workspace(), gitClient: git, queueRepository: 'iteathen/PATCH-POLLER' });
  const result = await store.compareAndSwap(task(), { expectedSha: null, envelope: envelope() });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'cas-lost');
  assert.equal(result.current.commitSha, OTHER);
  assert.equal(calls.filter((args) => args[0] === 'push').length, 1);
});

test('observed lease commit ancestry must match the signed predecessor', async () => {
  const currentEnvelope = envelope({ previousLeaseSha: EXPECTED, epoch: 4 });
  const ref = `refs/heads/patch-poller-control/leases/issue-49/${REVISION}`;
  const git = {
    async run(args) {
      if (args[0] === 'ls-remote') return success(`${OTHER}\t${ref}\n`);
      if (args[0] === 'fetch' || args[0] === 'cat-file') return success();
      if (args[0] === 'show' && args.includes('--format=%B')) return success(serializeSignedTaskLease(currentEnvelope));
      if (args[0] === 'show' && args.includes('--format=%P')) return success(`${'f'.repeat(40)}\n`);
      throw new Error(`unexpected git call ${args.join(' ')}`);
    },
  };
  const store = new GitTaskLeaseStore({ workspaceManager: workspace(), gitClient: git, queueRepository: 'iteathen/PATCH-POLLER' });
  await assert.rejects(store.observe(task()), /ancestry does not match its signed predecessor/u);
});
