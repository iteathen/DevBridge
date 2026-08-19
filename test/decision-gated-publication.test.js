import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DecisionGatedWorkspaceManager, DecisionRequiredError } from '../src/run/decision-gated-coordinator.js';
import { HardGateController } from '../src/run/hard-gate-controller.js';

class MemoryStore {
  data = new Map();
  async get(key) { return structuredClone(this.data.get(key)); }
  async set(key, value) { this.data.set(key, structuredClone(value)); }
}

const revision = 'a'.repeat(64);
const baselineSha = '1'.repeat(40);

function task() {
  return {
    queueRepository: 'owner/queue',
    issueNumber: 27,
    actorId: '1',
    revision,
    envelope: {
      target: { repository: 'owner/repo' },
      instructions: 'Change the security policy.',
      context: { constraints: [] },
    },
  };
}

function runState(t, worktreeDir) {
  return {
    version: 1,
    runId: `pp-${t.issueNumber}-${t.revision.slice(0, 16)}`,
    task: t,
    stage: 'verifying',
    turn: 1,
    turnLimit: 8,
    createdAt: new Date(0).toISOString(),
    workspace: { worktreeDir, branch: 'patchpoller/issue-27', baseSha: baselineSha, baseRef: 'main' },
    prior: {
      summary: null,
      decisions: [],
      provenance: [],
      progress: [],
      changedFiles: ['src/security/policy.js'],
      tests: [],
      git: null,
      blockers: [],
      nextStep: null,
      outputTail: null,
      receipt: null,
      liveness: null,
    },
    publication: { published: false },
    lastFeedbackCommentId: 0,
    transientRetry: null,
  };
}

test('task-branch publication rechecks the exact gate and blocks an approval that expired after sealing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-hard-gate-publish-'));
  const file = path.join(root, 'src', 'security', 'policy.js');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'approved candidate\n');

  const t = task();
  const state = runState(t, root);
  const store = new MemoryStore();
  const key = `run.owner/queue#${t.issueNumber}.${t.revision}`;
  await store.set(key, state);

  let clock = 1_000;
  const gate = new HardGateController({
    decisionAuthorities: { 'security-capability': ['1'] },
    approvalTtlMs: 60_000,
    architectureFileThreshold: 99,
    architectureOwnerThreshold: 99,
    nowMs: () => clock,
  });

  const snapshot = () => ({
    branch: 'patchpoller/issue-27',
    baseSha: baselineSha,
    headSha: baselineSha,
    dirty: true,
    changedFiles: ['src/security/policy.js'],
    unmergedFiles: [],
    status: ' M src/security/policy.js',
  });
  let publishCalls = 0;
  const delegate = {
    prepareRun: async () => ({ worktreeDir: root, branch: 'patchpoller/issue-27', baseSha: baselineSha, baseRef: 'main' }),
    validate: async () => snapshot(),
    snapshot: async () => snapshot(),
    sealCandidate: async () => ({ ...snapshot(), dirty: false, headSha: '2'.repeat(40) }),
    publishTaskBranch: async () => { publishCalls += 1; return { branch: 'patchpoller/issue-27', headSha: '2'.repeat(40) }; },
  };
  const workspace = new DecisionGatedWorkspaceManager({
    delegate,
    stateStore: store,
    queueRepository: 'owner/queue',
    gateController: gate,
  });

  try {
    const prepared = await workspace.prepareRun(t, state.runId, {});
    const persisted = await store.get(key);
    const initial = await gate.ensureCandidate({
      state: persisted,
      workspace: prepared,
      snapshot: snapshot(),
      persist: () => store.set(key, persisted),
    });
    assert.equal(initial.allowed, false);
    initial.checkpoint.state = 'approved';
    initial.checkpoint.resolvedAt = new Date(clock).toISOString();
    initial.checkpoint.decision = { action: 'approve', actorId: '1' };
    await store.set(key, persisted);

    const sealed = await workspace.sealCandidate(prepared, { issueNumber: t.issueNumber, revision: t.revision });
    assert.equal(sealed.headSha, '2'.repeat(40));

    clock = 61_001;
    await assert.rejects(
      () => workspace.publishTaskBranch(prepared),
      (error) => {
        assert.ok(error instanceof DecisionRequiredError);
        assert.equal(error.checkpoint.state, 'pending');
        assert.notEqual(error.checkpoint.checkpointId, initial.checkpoint.checkpointId);
        return true;
      },
    );
    assert.equal(publishCalls, 0);

    const after = await store.get(key);
    assert.equal(after.decisionGates.checkpoints[0].state, 'expired');
    assert.equal(after.decisionGates.checkpoints.at(-1).state, 'pending');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
