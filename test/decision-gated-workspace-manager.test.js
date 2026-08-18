import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DecisionGatePendingError, decisionGatedWorkspaceManager } from '../src/run/decision-gated-workspace-manager.js';

class MemoryStore {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
}

function policy() { return { authorityClasses: { 'security-change': ['1775584'] }, checkpointTtlMs: 60_000 }; }

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-decision-gate-'));
  await mkdir(path.join(root, 'src', 'security'), { recursive: true });
  const target = path.join(root, 'src', 'security', 'policy.js');
  await writeFile(target, 'export const policy = 1;\n');
  const workspace = { runId: 'pp-27-fixture', worktreeDir: root, branch: 'patchpoller/fixture' };
  let dirty = true;
  let headSha = 'a'.repeat(40);
  let sealCalls = 0;
  let publishCalls = 0;
  const delegate = {
    async validate() { return { baseSha: 'a'.repeat(40), headSha, dirty, changedFiles: dirty ? ['src/security/policy.js'] : [] }; },
    async snapshot() { return this.validate(); },
    async prepareRun() { return workspace; },
    async sealCandidate() { sealCalls += 1; dirty = false; headSha = 'b'.repeat(40); return this.validate(); },
    async publishTaskBranch() { publishCalls += 1; return { branch: workspace.branch, headSha }; },
  };
  return { root, target, workspace, delegate, stats: () => ({ sealCalls, publishCalls, dirty, headSha }), setHead: (value) => { headSha = value; dirty = false; } };
}

test('sensitive sealing checkpoints and proceeds through verification but cannot seal without exact approval', async () => {
  const fx = await fixture(); const store = new MemoryStore();
  try {
    const manager = decisionGatedWorkspaceManager({ delegate: fx.delegate, stateStore: store, feedbackSource: { pollDecision: async () => ({ decision: null, rejected: [], highestCommentId: 0 }) }, queueRepository: 'iteathen/PATCH-POLLER', decisionPolicy: policy() });
    await assert.rejects(() => manager.sealCandidate(fx.workspace, { issueNumber: 27, revision: 'c'.repeat(64) }), DecisionGatePendingError);
    assert.equal(fx.stats().sealCalls, 0);
    const state = await store.get(`decision.iteathen/PATCH-POLLER#${fx.workspace.runId}`);
    assert.equal(state.checkpoints[0].state, 'pending');
    assert.deepEqual(state.checkpoints[0].sensitivePaths, ['src/security/policy.js']);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('matching locally authorized approval allows exact seal and binds publication to resulting commit', async () => {
  const fx = await fixture(); const store = new MemoryStore(); let approve = false;
  try {
    const feedbackSource = { pollDecision: async (request) => ({ decision: approve ? { protocol: 'patch-poller/decision-v1', runId: request.runId, taskRevision: request.taskRevision, checkpointId: request.checkpointId, subjectDigest: request.subjectDigest, action: 'approve', actorId: '1775584', actorLogin: 'trusted', commentId: 1, authorityProvenance: { provenanceSha256: 'd'.repeat(64) } } : null, rejected: [], highestCommentId: approve ? 1 : 0 }) };
    const manager = decisionGatedWorkspaceManager({ delegate: fx.delegate, stateStore: store, feedbackSource, queueRepository: 'iteathen/PATCH-POLLER', decisionPolicy: policy() });
    await assert.rejects(() => manager.sealCandidate(fx.workspace, { issueNumber: 27, revision: 'c'.repeat(64) }), DecisionGatePendingError);
    approve = true;
    const sealed = await manager.sealCandidate(fx.workspace, { issueNumber: 27, revision: 'c'.repeat(64) });
    assert.equal(sealed.headSha, 'b'.repeat(40));
    assert.equal(fx.stats().sealCalls, 1);
    const published = await manager.publishTaskBranch(fx.workspace);
    assert.equal(published.headSha, sealed.headSha);
    assert.equal(fx.stats().publishCalls, 1);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('artifact-exact approval is superseded when candidate bytes change', async () => {
  const fx = await fixture(); const store = new MemoryStore(); let approve = true;
  try {
    const feedbackSource = { pollDecision: async (request) => ({ decision: approve ? { runId: request.runId, taskRevision: request.taskRevision, checkpointId: request.checkpointId, subjectDigest: request.subjectDigest, action: 'approve', actorId: '1775584', commentId: 1, authorityProvenance: { provenanceSha256: 'd'.repeat(64) } } : null, rejected: [], highestCommentId: approve ? 1 : 0 }) };
    const manager = decisionGatedWorkspaceManager({ delegate: fx.delegate, stateStore: store, feedbackSource, queueRepository: 'iteathen/PATCH-POLLER', decisionPolicy: policy() });
    const first = await manager.assertDecisionGate(fx.workspace, { issueNumber: 27, revision: 'c'.repeat(64) });
    assert.equal(first.checkpoint.state, 'approved');
    approve = false;
    await writeFile(fx.target, 'export const policy = 2;\n');
    await assert.rejects(() => manager.assertDecisionGate(fx.workspace, { issueNumber: 27, revision: 'c'.repeat(64) }), DecisionGatePendingError);
    const state = await store.get(`decision.iteathen/PATCH-POLLER#${fx.workspace.runId}`);
    assert.equal(state.checkpoints[0].state, 'superseded');
    assert.equal(state.checkpoints[1].state, 'pending');
    assert.notEqual(state.checkpoints[0].subjectDigest, state.checkpoints[1].subjectDigest);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('publication of a non-baseline commit is blocked unless this run sealed that exact commit', async () => {
  const fx = await fixture(); const store = new MemoryStore();
  try {
    fx.setHead('e'.repeat(40));
    const manager = decisionGatedWorkspaceManager({ delegate: fx.delegate, stateStore: store, feedbackSource: null, queueRepository: 'iteathen/PATCH-POLLER', decisionPolicy: policy() });
    await assert.rejects(() => manager.publishTaskBranch(fx.workspace), /not produced by this run/u);
    assert.equal(fx.stats().publishCalls, 0);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test('expired approval never authorizes sealing', async () => {
  const fx = await fixture(); const store = new MemoryStore(); let now = 1_000_000;
  try {
    const feedbackSource = { pollDecision: async (request) => ({ decision: { runId: request.runId, taskRevision: request.taskRevision, checkpointId: request.checkpointId, subjectDigest: request.subjectDigest, action: 'approve', actorId: '1775584', commentId: 1, authorityProvenance: { provenanceSha256: 'd'.repeat(64) } }, rejected: [], highestCommentId: 1 }) };
    const manager = decisionGatedWorkspaceManager({ delegate: fx.delegate, stateStore: store, feedbackSource, queueRepository: 'iteathen/PATCH-POLLER', decisionPolicy: { ...policy(), checkpointTtlMs: 1000 }, nowMs: () => now });
    const gate = await manager.assertDecisionGate(fx.workspace, { issueNumber: 27, revision: 'c'.repeat(64) });
    assert.equal(gate.checkpoint.state, 'approved');
    now += 2000;
    await assert.rejects(() => manager.sealCandidate(fx.workspace, { issueNumber: 27, revision: 'c'.repeat(64) }), /expired/u);
    assert.equal(fx.stats().sealCalls, 0);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});
