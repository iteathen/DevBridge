import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CandidateDecisionGate } from '../src/run/candidate-decision-gate.js';

class FakeWorkspaceManager {
  constructor(changedFiles) { this.changedFiles = changedFiles; }
  async validate(workspace) {
    return {
      branch: 'task/test',
      baseSha: workspace.baseSha,
      headSha: workspace.baseSha,
      dirty: true,
      changedFiles: [...this.changedFiles],
    };
  }
}

class ToggleDecisionSource {
  approve = false;
  counter = 100;
  async pollCheckpoint({ checkpoint, afterCommentId }) {
    if (!this.approve) return { decision: null, unchanged: false, highestCommentId: afterCommentId, reason: 'no-matching-decision' };
    this.counter += 1;
    return {
      unchanged: false,
      highestCommentId: this.counter,
      reason: null,
      decision: {
        protocol: 'patch-poller/decision-v1',
        runId: checkpoint.runId,
        taskRevision: checkpoint.taskRevision,
        checkpointId: checkpoint.checkpointId,
        subjectDigest: checkpoint.subjectDigest,
        action: 'approve',
        instructions: null,
        actorId: '1775584',
        actorLogin: 'iteathen',
        commentId: this.counter,
        createdAt: new Date().toISOString(),
      }
    };
  }
}

async function fixture(relativePath, content = 'first') {
  const worktreeDir = await mkdtemp(path.join(os.tmpdir(), 'pp-decision-gate-'));
  await mkdir(path.dirname(path.join(worktreeDir, relativePath)), { recursive: true });
  await writeFile(path.join(worktreeDir, relativePath), content);
  return {
    workspace: {
      worktreeDir,
      repository: 'iteathen/PATCH-POLLER',
      baseSha: 'b'.repeat(40),
      runId: 'pp-1-aaaa',
    },
    task: { issueNumber: 1, revision: 'a'.repeat(64) },
  };
}

test('control-plane approval is artifact-exact and invalidates on post-approval byte change', async () => {
  const { workspace, task } = await fixture('src/config.js', 'first');
  const manager = new FakeWorkspaceManager(['src/config.js']);
  const source = new ToggleDecisionSource();
  const gate = new CandidateDecisionGate({ workspaceManager: manager, decisionSource: source });
  const state = { decisionGate: null, decisionHistory: [] };
  const persist = async () => {};

  const pending = await gate.evaluate({ state, task, workspace, persist });
  assert.equal(pending.authorized, false);
  assert.equal(pending.pending, true);
  assert.equal(pending.checkpoint.decisionClass, 'control-plane');
  assert.equal(pending.checkpoint.bindingMode, 'artifact-exact');
  const firstSubject = pending.checkpoint.subjectDigest;

  source.approve = true;
  const approved = await gate.evaluate({ state, task, workspace, persist });
  assert.equal(approved.authorized, true);
  assert.equal(state.decisionGate.state, 'approved');

  source.approve = false;
  await writeFile(path.join(workspace.worktreeDir, 'src/config.js'), 'second');
  const invalidated = await gate.evaluate({ state, task, workspace, persist });
  assert.equal(invalidated.authorized, false);
  assert.equal(invalidated.pending, true);
  assert.equal(invalidated.checkpoint.state, 'pending');
  assert.notEqual(invalidated.checkpoint.subjectDigest, firstSubject);
  assert.equal(state.decisionHistory.at(-1).state, 'superseded');
});

test('contract approval is decision-scope bound and survives byte evolution inside the same approved path set', async () => {
  const { workspace, task } = await fixture('specs/example.md', 'first');
  const manager = new FakeWorkspaceManager(['specs/example.md']);
  const source = new ToggleDecisionSource();
  const gate = new CandidateDecisionGate({ workspaceManager: manager, decisionSource: source });
  const state = { decisionGate: null, decisionHistory: [] };
  const persist = async () => {};

  await gate.evaluate({ state, task, workspace, persist });
  assert.equal(state.decisionGate.decisionClass, 'contract');
  assert.equal(state.decisionGate.bindingMode, 'decision-scope');
  const approvedSubject = state.decisionGate.subjectDigest;
  const firstArtifact = state.decisionGate.artifactDigest;

  source.approve = true;
  const approved = await gate.evaluate({ state, task, workspace, persist });
  assert.equal(approved.authorized, true);

  source.approve = false;
  await writeFile(path.join(workspace.worktreeDir, 'specs/example.md'), 'second');
  const stillApproved = await gate.evaluate({ state, task, workspace, persist });
  assert.equal(stillApproved.authorized, true);
  assert.equal(stillApproved.checkpoint.state, 'approved');
  assert.equal(stillApproved.checkpoint.subjectDigest, approvedSubject);
  assert.notEqual(stillApproved.checkpoint.artifactDigest, firstArtifact);
});
