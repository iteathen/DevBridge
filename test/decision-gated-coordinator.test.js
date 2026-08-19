import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HardGateController } from '../src/run/hard-gate-controller.js';
import { DecisionGatedRunCoordinator, DecisionGatedWorkspaceManager } from '../src/run/decision-gated-coordinator.js';

class MemoryStore {
  data = new Map();
  async get(key) { return structuredClone(this.data.get(key)); }
  async set(key, value) { this.data.set(key, structuredClone(value)); }
  async entries(prefix = '') {
    return [...this.data.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key, structuredClone(value)]);
  }
}

const revision = 'a'.repeat(64);
const baselineSha = '1'.repeat(40);

function task({ controllerPlan = null } = {}) {
  return {
    queueRepository: 'owner/queue',
    issueNumber: 27,
    actorId: '1',
    revision,
    envelope: {
      target: { repository: 'owner/repo' },
      instructions: 'Change the security policy.',
      preferredTool: controllerPlan ? null : 'fixture',
      controllerPlan,
      context: { constraints: [] },
    },
  };
}

function stateFor(t, worktreeDir) {
  return {
    version: 1,
    runId: `pp-${t.issueNumber}-${t.revision.slice(0, 16)}`,
    task: t,
    stage: 'verifying',
    turn: 1,
    turnLimit: 8,
    createdAt: new Date().toISOString(),
    workspace: { worktreeDir, branch: 'devbridge/issue-27', baseSha: baselineSha, baseRef: 'main' },
    prior: {
      summary: null,
      decisions: [],
      provenance: [],
      progress: [],
      changedFiles: ['src/security/policy.js'],
      tests: [],
      git: { branch: 'devbridge/issue-27', baseSha: baselineSha, headSha: baselineSha, dirty: true },
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

function verifiedProvenance(actorId = '1') {
  return {
    verified: true,
    reason: null,
    contentSha256: 'c'.repeat(64),
    creatorActorId: actorId,
    currentEditorActorId: null,
    editorActorIds: [],
    editCount: 0,
    redactedEditCount: 0,
    historyComplete: true,
    lastEditedAt: null,
  };
}

function decisionSource(actions = []) {
  let index = 0;
  return {
    calls: [],
    async pollWaitingDecision(request) {
      this.calls.push(structuredClone(request));
      const action = actions[index++] ?? null;
      if (!action) return { decision: null, rejected: [], unchanged: false, highestCommentId: request.afterCommentId };
      return {
        decision: {
          protocol: 'devbridge/decision-v1',
          runId: request.runId,
          taskRevision: request.taskRevision,
          checkpointId: request.checkpointId,
          subjectDigest: request.subjectDigest,
          action: action.action,
          instructions: action.instructions ?? null,
          contentSha256: 'c'.repeat(64),
          commentId: action.commentId ?? 100 + index,
          actorId: action.actorId ?? '1',
          actorLogin: 'trusted',
          provenance: verifiedProvenance(action.actorId ?? '1'),
        },
        rejected: [],
        unchanged: false,
        highestCommentId: action.commentId ?? 100 + index,
      };
    },
  };
}

async function fixture({ actions = [], nowMs = () => Date.now(), controllerPlan = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-hard-gate-'));
  await writeFile(path.join(root, 'policy.js'), 'placeholder\n');
  await writeFile(path.join(root, 'src-security-policy.js'), 'placeholder\n');
  const target = path.join(root, 'src', 'security');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(target, { recursive: true }));
  await writeFile(path.join(target, 'policy.js'), 'authorized candidate\n');

  const t = task({ controllerPlan });
  const store = new MemoryStore();
  const key = `run.owner/queue#${t.issueNumber}.${t.revision}`;
  await store.set(key, stateFor(t, root));
  const source = decisionSource(actions);
  const gate = new HardGateController({
    decisionSource: source,
    decisionAuthorities: { 'security-capability': ['1'] },
    approvalTtlMs: 60_000,
    architectureFileThreshold: 99,
    architectureOwnerThreshold: 99,
    nowMs,
  });

  let sealCalls = 0;
  let publishCalls = 0;
  const snapshot = () => ({
    branch: 'devbridge/issue-27',
    baseSha: baselineSha,
    headSha: baselineSha,
    dirty: true,
    changedFiles: ['src/security/policy.js'],
    unmergedFiles: [],
    status: ' M src/security/policy.js',
  });
  const rawWorkspace = {
    validate: async () => snapshot(),
    snapshot: async () => snapshot(),
    prepareRun: async () => ({ worktreeDir: root, branch: 'devbridge/issue-27', baseSha: baselineSha, baseRef: 'main' }),
    sealCandidate: async () => {
      sealCalls += 1;
      return { ...snapshot(), headSha: '2'.repeat(40), dirty: false };
    },
    publishTaskBranch: async () => {
      publishCalls += 1;
      return { branch: 'devbridge/issue-27', headSha: '2'.repeat(40) };
    },
  };
  const gatedWorkspace = new DecisionGatedWorkspaceManager({
    delegate: rawWorkspace,
    stateStore: store,
    queueRepository: 'owner/queue',
    gateController: gate,
  });

  const reports = [];
  let delegateCalls = 0;
  let delegateMode = 'seal';
  const observed = [];
  const delegate = {
    async executeTask(currentTask) {
      delegateCalls += 1;
      const persisted = await store.get(key);
      if (['completed', 'failed', 'cancelled'].includes(persisted.stage)) {
        return { runId: persisted.runId, issueNumber: currentTask.issueNumber, status: persisted.stage, skipped: true };
      }
      if (delegateMode === 'observe-running') {
        observed.push({ stage: persisted.stage, nextStep: persisted.prior.nextStep });
        return { runId: persisted.runId, issueNumber: currentTask.issueNumber, status: persisted.stage };
      }
      const workspace = { worktreeDir: root, branch: 'devbridge/issue-27', baseSha: baselineSha, baseRef: 'main' };
      const sealed = await gatedWorkspace.sealCandidate(workspace, { issueNumber: currentTask.issueNumber, revision: currentTask.revision });
      await gatedWorkspace.publishTaskBranch(workspace);
      persisted.stage = 'completed';
      persisted.finalSnapshot = sealed;
      persisted.publication = { published: true, headSha: sealed.headSha };
      await store.set(key, persisted);
      return { runId: persisted.runId, issueNumber: currentTask.issueNumber, status: 'completed', published: true };
    },
  };
  const coordinator = new DecisionGatedRunCoordinator({
    delegate,
    stateStore: store,
    statusReporter: { publish: async (value) => { reports.push(structuredClone(value)); return { published: true }; } },
    gateController: gate,
    queueRepository: 'owner/queue',
    maxTurns: 8,
  });
  return {
    root, t, key, store, source, gate, rawWorkspace, gatedWorkspace, coordinator, reports, observed,
    counts: () => ({ sealCalls, publishCalls, delegateCalls }),
    setDelegateMode: (value) => { delegateMode = value; },
  };
}

test('sensitive candidate reaches a durable hard gate before seal/publication and silence does not rerun work', async () => {
  const f = await fixture();
  try {
    const first = await f.coordinator.executeTask(f.t);
    assert.equal(first.status, 'waiting-decision');
    assert.equal(first.decisionClasses.includes('security-capability'), true);
    assert.deepEqual(f.counts(), { sealCalls: 0, publishCalls: 0, delegateCalls: 1 });
    const persisted = await f.store.get(f.key);
    assert.equal(persisted.stage, 'waiting-decision');
    assert.equal(persisted.decisionGates.checkpoints.length, 1);
    assert.equal(persisted.decisionGates.checkpoints[0].state, 'pending');
    assert.ok(persisted.prior.decisions.some((entry) => entry.source === 'hard-gate-checkpoint'));

    const resumed = await f.coordinator.resumePending();
    assert.equal(resumed.status, 'waiting-decision');
    assert.deepEqual(f.counts(), { sealCalls: 0, publishCalls: 0, delegateCalls: 1 });
    assert.equal(resumed.checkpointId, first.checkpointId);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('exact approval survives restart, rechecks the subject, then seals and publishes exactly once', async () => {
  const f = await fixture({ actions: [{ action: 'approve', commentId: 201 }] });
  try {
    const first = await f.coordinator.executeTask(f.t);
    assert.equal(first.status, 'waiting-decision');

    const restarted = new DecisionGatedRunCoordinator({
      delegate: {
        async executeTask(currentTask) {
          const persisted = await f.store.get(f.key);
          if (persisted.stage === 'completed') return { status: 'completed', skipped: true };
          const workspace = { worktreeDir: f.root, branch: 'devbridge/issue-27', baseSha: baselineSha, baseRef: 'main' };
          const sealed = await f.gatedWorkspace.sealCandidate(workspace, { issueNumber: currentTask.issueNumber, revision: currentTask.revision });
          await f.gatedWorkspace.publishTaskBranch(workspace);
          persisted.stage = 'completed';
          persisted.finalSnapshot = sealed;
          persisted.publication = { published: true, headSha: sealed.headSha };
          await f.store.set(f.key, persisted);
          return { status: 'completed', published: true };
        },
      },
      stateStore: f.store,
      gateController: f.gate,
      queueRepository: 'owner/queue',
    });
    const completed = await restarted.resumePending();
    assert.equal(completed.status, 'completed');
    assert.deepEqual(f.counts(), { sealCalls: 1, publishCalls: 1, delegateCalls: 1 });
    const persisted = await f.store.get(f.key);
    assert.equal(persisted.decisionGates.checkpoints[0].state, 'approved');
    assert.equal(persisted.prior.decisions.some((entry) => entry.source === 'trusted-decision' && entry.action === 'approve'), true);

    const duplicate = await restarted.executeTask(f.t);
    assert.equal(duplicate.status, 'completed');
    assert.deepEqual(f.counts(), { sealCalls: 1, publishCalls: 1, delegateCalls: 1 });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('artifact change after approval supersedes it and creates a new pending exact checkpoint before seal', async () => {
  const f = await fixture({ actions: [{ action: 'approve', commentId: 202 }] });
  try {
    const first = await f.coordinator.executeTask(f.t);
    const originalCheckpointId = first.checkpointId;
    await writeFile(path.join(f.root, 'src', 'security', 'policy.js'), 'mutated after approval request\n');
    const resumed = await f.coordinator.resumePending();
    assert.equal(resumed.status, 'waiting-decision');
    assert.notEqual(resumed.checkpointId, originalCheckpointId);
    assert.deepEqual(f.counts(), { sealCalls: 0, publishCalls: 0, delegateCalls: 2 });
    const persisted = await f.store.get(f.key);
    assert.equal(persisted.decisionGates.checkpoints[0].state, 'superseded');
    assert.equal(persisted.decisionGates.checkpoints.at(-1).state, 'pending');
    assert.notEqual(persisted.decisionGates.checkpoints[0].subjectDigest, persisted.decisionGates.checkpoints.at(-1).subjectDigest);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rejected model candidate returns to bounded safe work without sealing the rejected subject', async () => {
  const f = await fixture({ actions: [{ action: 'reject', commentId: 203 }] });
  try {
    await f.coordinator.executeTask(f.t);
    f.setDelegateMode('observe-running');
    const result = await f.coordinator.resumePending();
    assert.equal(result.status, 'running');
    assert.deepEqual(f.counts(), { sealCalls: 0, publishCalls: 0, delegateCalls: 2 });
    assert.equal(f.observed[0].stage, 'running');
    assert.match(f.observed[0].nextStep, /rejected the gated candidate/u);
    const persisted = await f.store.get(f.key);
    assert.equal(persisted.decisionGates.currentCheckpointId, null);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('redirected model candidate receives bounded human direction but no seal authority', async () => {
  const f = await fixture({ actions: [{ action: 'redirect', instructions: 'Keep the security boundary but avoid changing public specs.', commentId: 204 }] });
  try {
    await f.coordinator.executeTask(f.t);
    f.setDelegateMode('observe-running');
    const result = await f.coordinator.resumePending();
    assert.equal(result.status, 'running');
    assert.deepEqual(f.counts(), { sealCalls: 0, publishCalls: 0, delegateCalls: 2 });
    assert.match(f.observed[0].nextStep, /avoid changing public specs/u);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('rejecting an immutable controller plan is terminal and never seals it', async () => {
  const f = await fixture({
    controllerPlan: { protocol: 'devbridge/controller-plan-v1' },
    actions: [{ action: 'reject', commentId: 205 }],
  });
  try {
    await f.coordinator.executeTask(f.t);
    const result = await f.coordinator.resumePending();
    assert.equal(result.status, 'failed');
    assert.equal(result.error.classification, 'DECISION_REJECTED');
    assert.deepEqual(f.counts(), { sealCalls: 0, publishCalls: 0, delegateCalls: 1 });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('expired silence creates a fresh checkpoint instead of becoming approval', async () => {
  let now = 1_700_000_000_000;
  const f = await fixture({ nowMs: () => now });
  try {
    const first = await f.coordinator.executeTask(f.t);
    now += 60_001;
    const second = await f.coordinator.resumePending();
    assert.equal(second.status, 'waiting-decision');
    assert.notEqual(second.checkpointId, first.checkpointId);
    assert.deepEqual(f.counts(), { sealCalls: 0, publishCalls: 0, delegateCalls: 2 });
    const persisted = await f.store.get(f.key);
    assert.equal(persisted.decisionGates.checkpoints[0].state, 'expired');
    assert.equal(persisted.decisionGates.checkpoints.at(-1).state, 'pending');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
