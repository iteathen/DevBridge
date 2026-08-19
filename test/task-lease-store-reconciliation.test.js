import test from 'node:test';
import assert from 'node:assert/strict';
import { GitTaskLeaseStore } from '../src/git/task-lease-store.js';
import { SIGNED_TASK_LEASE_PROTOCOL, TASK_LEASE_PROTOCOL, serializeSignedTaskLease } from '../src/run/task-lease.js';

const REVISION = '1'.repeat(64);
const OWNER = '2'.repeat(64);
const TREE = 'a'.repeat(40);
const CREATED = 'b'.repeat(40);

function envelope() {
  return {
    protocol: SIGNED_TASK_LEASE_PROTOCOL,
    subject: {
      protocol: TASK_LEASE_PROTOCOL,
      queueRepository: 'iteathen/DevBridge',
      issueNumber: 49,
      taskRevision: REVISION,
      ownerFingerprint: OWNER,
      ownerAddress: `agent#${OWNER}`,
      sessionId: '3'.repeat(32),
      epoch: 1,
      state: 'active',
      issuedAt: '2026-08-19T03:00:00.000Z',
      expiresAt: '2026-08-19T03:20:00.000Z',
      previousLeaseSha: null,
    },
    signature: Buffer.alloc(64, 7).toString('base64'),
  };
}

function success(stdout = '') { return { exitCode: 0, timedOut: false, stdout, stderr: '' }; }

test('timed-out task lease push is accepted only when re-observation finds the exact attempted commit', async () => {
  const task = { queueRepository: 'iteathen/DevBridge', issueNumber: 49, revision: REVISION };
  const ref = `refs/heads/devbridge-control/leases/issue-49/${REVISION}`;
  const signed = envelope();
  const git = {
    async run(args) {
      if (args[0] === 'rev-parse') return success(`${TREE}\n`);
      if (args.includes('commit-tree')) return success(`${CREATED}\n`);
      if (args[0] === 'push') return { exitCode: null, timedOut: true, stdout: '', stderr: '' };
      if (args[0] === 'ls-remote') return success(`${CREATED}\t${ref}\n`);
      if (args[0] === 'fetch' || args[0] === 'cat-file') return success();
      if (args[0] === 'show' && args.includes('--format=%B')) return success(serializeSignedTaskLease(signed));
      if (args[0] === 'show' && args.includes('--format=%P')) return success('\n');
      throw new Error(`unexpected git call ${args.join(' ')}`);
    },
  };
  const store = new GitTaskLeaseStore({
    workspaceManager: {
      ensureRepository: async () => ({
        repoDir: '/control/repo',
        remoteUrl: 'https://github.com/iteathen/DevBridge.git',
        baseSha: 'e'.repeat(40),
      }),
    },
    gitClient: git,
    queueRepository: 'iteathen/DevBridge',
  });
  const result = await store.compareAndSwap(task, { expectedSha: null, envelope: signed });
  assert.equal(result.updated, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.commitSha, CREATED);
});
