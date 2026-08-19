import test from 'node:test';
import assert from 'node:assert/strict';
import { BaselineReverificationRequiredError } from '../src/errors.js';
import { RunCoordinator } from '../src/run/run-coordinator.js';

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

const BASE_A = '1'.repeat(40);
const BASE_B = '2'.repeat(40);
const HEAD_A = '3'.repeat(40);
const HEAD_B = '4'.repeat(40);
const BRANCH = 'devbridge/issue-49-aaaaaaaaaaaa';

const profile = {
  executable: process.execPath,
  args: [],
  inputMode: 'stdin-json',
  timeoutMs: 1000,
  maxOutputBytes: 4096,
  environment: { pass: [], set: {} },
  sandbox: { enforcement: 'os', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' }
};

function controllerPlanTask() {
  return {
    queueRepository: 'owner/queue',
    issueNumber: 49,
    actorId: '1',
    revision: 'a'.repeat(64),
    envelope: {
      target: { repository: 'owner/repo' },
      instructions: 'verify the candidate',
      preferredTool: 'fixture',
      context: { constraints: [] },
      controllerPlan: {
        protocol: 'devbridge/controller-plan-v1',
        baselineChannel: null,
        files: [],
        operations: [],
        assertions: [],
        expectedChangedPaths: []
      }
    }
  };
}

function candidateSnapshot(workspace, headSha) {
  return {
    branch: workspace.branch,
    baseSha: workspace.baseSha,
    publicationBaseSha: workspace.publicationBaseSha,
    headSha,
    dirty: false,
    changedFiles: ['candidate.js'],
    unmergedFiles: [],
    status: ''
  };
}

function priorState(snapshot) {
  return {
    summary: null,
    decisions: [],
    provenance: [],
    progress: ['candidate verified'],
    changedFiles: snapshot.changedFiles,
    tests: ['stale-before-baseline-drift'],
    git: {
      branch: snapshot.branch,
      baseSha: snapshot.baseSha,
      publicationBaseSha: snapshot.publicationBaseSha,
      headSha: snapshot.headSha,
      dirty: snapshot.dirty
    },
    blockers: [],
    nextStep: null,
    outputTail: null,
    receipt: null,
    liveness: null
  };
}

async function seedPublishingState(store, task, workspace, { turn, turnLimit }) {
  const snapshot = candidateSnapshot(workspace, HEAD_A);
  const key = `run.owner/queue#${task.issueNumber}.${task.revision}`;
  await store.set(key, {
    version: 1,
    runId: `pp-${task.issueNumber}-${task.revision.slice(0, 16)}`,
    task,
    stage: 'publishing',
    turn,
    turnLimit,
    createdAt: new Date().toISOString(),
    prior: priorState(snapshot),
    workspace: structuredClone(workspace),
    finalSnapshot: snapshot,
    lastFeedbackCommentId: 0,
    publication: { published: false },
    transientRetry: null
  });
  return key;
}

function baselineDriftWorkspace() {
  const workspace = {
    repository: 'owner/repo',
    repoDir: '/managed/repo',
    worktreeDir: '/managed/run',
    branch: BRANCH,
    baseRef: 'origin/main',
    baseSha: BASE_A,
    publicationBaseSha: BASE_A,
    taskBranchKnownRemoteHeads: [HEAD_A]
  };
  let sealCalls = 0;
  let publishCalls = 0;
  const publicationOptions = [];
  return {
    workspace,
    get sealCalls() { return sealCalls; },
    get publishCalls() { return publishCalls; },
    publicationOptions,
    manager: {
      async prepareRun(_task, _runId, resume = {}) {
        workspace.baseSha = resume.baseSha ?? workspace.baseSha;
        workspace.publicationBaseSha = resume.publicationBaseSha ?? workspace.publicationBaseSha;
        workspace.taskBranchKnownRemoteHeads = [...(resume.taskBranchKnownRemoteHeads ?? workspace.taskBranchKnownRemoteHeads)];
        return workspace;
      },
      async snapshot() {
        return candidateSnapshot(workspace, workspace.publicationBaseSha === BASE_A ? HEAD_A : HEAD_B);
      },
      async validate() {
        return candidateSnapshot(workspace, workspace.publicationBaseSha === BASE_A ? HEAD_A : HEAD_B);
      },
      async sealCandidate() {
        sealCalls += 1;
        if (sealCalls === 1) {
          workspace.publicationBaseSha = BASE_B;
          throw new BaselineReverificationRequiredError('baseline advanced while deterministic publication was interrupted', {
            changed: true,
            fromBaseSha: BASE_A,
            toBaseSha: BASE_B,
            fromHeadSha: HEAD_A,
            toHeadSha: HEAD_B
          });
        }
        return candidateSnapshot(workspace, HEAD_B);
      },
      async publishTaskBranch(_workspace, options) {
        publishCalls += 1;
        publicationOptions.push(structuredClone(options));
        return { branch: BRANCH, headSha: options.expectedHeadSha };
      }
    }
  };
}

test('resumed deterministic publication consumes the next attempt when baseline drift forces reverification', async () => {
  const store = new MemoryStore();
  const task = controllerPlanTask();
  const drift = baselineDriftWorkspace();
  const key = await seedPublishingState(store, task, drift.workspace, { turn: 1, turnLimit: 3 });
  let executions = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: drift.manager,
    processRunner: { run: async () => { throw new Error('model must not run for controller plan'); } },
    controllerPlanExecutor: {
      async execute({ state, workspace }) {
        executions += 1;
        assert.equal(state.turn, 2);
        assert.equal(workspace.publicationBaseSha, BASE_B);
        assert.deepEqual(state.prior.tests, []);
        return {
          snapshot: candidateSnapshot(workspace, HEAD_B),
          tests: [{ operation: 'fixture.verify', id: 'post-restart-baseline-reverify', exitCode: 0 }],
          summary: 'deterministic baseline reverified after restart'
        };
      }
    },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3,
    autoPushTaskBranches: true
  });

  const result = await coordinator.executeTask(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.publicationBaseSha, BASE_B);
  assert.equal(executions, 1);
  assert.equal(drift.sealCalls, 2);
  assert.equal(drift.publishCalls, 1);
  assert.deepEqual(drift.publicationOptions, [{ expectedHeadSha: HEAD_B }]);
  const state = await store.get(key);
  assert.equal(state.turn, 2);
  assert.deepEqual(state.prior.tests, [{ operation: 'fixture.verify', id: 'post-restart-baseline-reverify', exitCode: 0 }]);
});

test('resumed deterministic publication checkpoints when baseline drift finds the attempt window exhausted', async () => {
  const store = new MemoryStore();
  const task = controllerPlanTask();
  const drift = baselineDriftWorkspace();
  const key = await seedPublishingState(store, task, drift.workspace, { turn: 3, turnLimit: 3 });
  let executions = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: drift.manager,
    processRunner: { run: async () => { throw new Error('model must not run for controller plan'); } },
    controllerPlanExecutor: {
      async execute() {
        executions += 1;
        throw new Error('exhausted deterministic baseline reverification must not replay');
      }
    },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3,
    autoPushTaskBranches: true
  });

  const result = await coordinator.executeTask(task);
  assert.equal(result.status, 'waiting-feedback');
  assert.equal(result.waiting, true);
  assert.equal(executions, 0);
  assert.equal(drift.sealCalls, 1);
  assert.equal(drift.publishCalls, 0);
  const state = await store.get(key);
  assert.equal(state.stage, 'waiting-feedback');
  assert.equal(state.baselineReverifyRequired, false);
  assert.deepEqual(state.prior.tests, []);
  assert.match(state.prior.blockers[0], /bounded 3-attempt deterministic reverification window/u);
});
