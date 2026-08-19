import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BaselineReconciliationError,
  BaselineReverificationRequiredError,
} from '../src/errors.js';
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

function task({ controllerPlan = null } = {}) {
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
      ...(controllerPlan ? { controllerPlan } : {})
    }
  };
}

function controllerPlanFixture() {
  return {
    protocol: 'devbridge/controller-plan-v1',
    baselineChannel: null,
    files: [],
    operations: [],
    assertions: [],
    expectedChangedPaths: []
  };
}

function snapshot(workspace, { headSha = HEAD_A, dirty = false, changedFiles = ['candidate.js'] } = {}) {
  return {
    branch: workspace.branch,
    baseSha: workspace.baseSha,
    publicationBaseSha: workspace.publicationBaseSha,
    headSha,
    dirty,
    changedFiles,
    unmergedFiles: [],
    status: dirty ? ' M candidate.js' : ''
  };
}

function priorState(snapshotValue, tests = []) {
  return {
    summary: null,
    decisions: [],
    provenance: [],
    progress: ['candidate sealed'],
    changedFiles: snapshotValue.changedFiles,
    tests: [...tests],
    git: {
      branch: snapshotValue.branch,
      baseSha: snapshotValue.baseSha,
      publicationBaseSha: snapshotValue.publicationBaseSha,
      headSha: snapshotValue.headSha,
      dirty: snapshotValue.dirty
    },
    blockers: [],
    nextStep: null,
    outputTail: null,
    receipt: null,
    liveness: null
  };
}

async function seedPublishingRun(store, t, workspace, verifiedSnapshot, {
  turn = 1,
  turnLimit = 3,
  tests = ['stale-verification']
} = {}) {
  const runId = `pp-${t.issueNumber}-${t.revision.slice(0, 16)}`;
  const key = `run.owner/queue#${t.issueNumber}.${t.revision}`;
  await store.set(key, {
    version: 1,
    runId,
    task: t,
    stage: 'publishing',
    turn,
    turnLimit,
    createdAt: new Date().toISOString(),
    prior: priorState(verifiedSnapshot, tests),
    workspace: structuredClone(workspace),
    finalSnapshot: structuredClone(verifiedSnapshot),
    lastFeedbackCommentId: 0,
    publication: { published: false },
    transientRetry: null
  });
  return key;
}

function driftingWorkspace({ reconciliationError = null } = {}) {
  const workspace = {
    repository: 'owner/repo',
    repoDir: '/managed/repo',
    worktreeDir: '/managed/run',
    branch: BRANCH,
    baseRef: 'origin/main',
    baseSha: BASE_A,
    publicationBaseSha: BASE_A,
    taskBranchKnownRemoteHeads: []
  };
  let sealCalls = 0;
  return {
    workspace,
    get sealCalls() { return sealCalls; },
    manager: {
      async prepareRun(_task, _runId, resume = {}) {
        if (resume.baseSha) workspace.baseSha = resume.baseSha;
        if (resume.publicationBaseSha) workspace.publicationBaseSha = resume.publicationBaseSha;
        if (resume.taskBranchKnownRemoteHeads) workspace.taskBranchKnownRemoteHeads = [...resume.taskBranchKnownRemoteHeads];
        return workspace;
      },
      async snapshot() { return snapshot(workspace, { headSha: workspace.publicationBaseSha === BASE_A ? HEAD_A : HEAD_B }); },
      async validate() { return snapshot(workspace, { headSha: workspace.publicationBaseSha === BASE_A ? HEAD_A : HEAD_B }); },
      async sealCandidate() {
        sealCalls += 1;
        if (sealCalls === 1) {
          if (reconciliationError) throw reconciliationError;
          workspace.publicationBaseSha = BASE_B;
          throw new BaselineReverificationRequiredError(
            `upstream baseline advanced from ${BASE_A} to ${BASE_B}`,
            { changed: true, fromBaseSha: BASE_A, toBaseSha: BASE_B, fromHeadSha: HEAD_A, toHeadSha: HEAD_B }
          );
        }
        return snapshot(workspace, { headSha: HEAD_B });
      },
      async publishTaskBranch() { return { branch: BRANCH, headSha: HEAD_B }; }
    }
  };
}

function completedRun(summary, tests) {
  return {
    result: {
      protocol: 'devbridge/result-v1',
      status: 'complete',
      summary,
      progress: [],
      tests,
      nextStep: null
    },
    resultParseError: null,
    exitCode: 0,
    timedOut: false,
    stdout: '',
    stderr: ''
  };
}

test('model candidate is reverified after baseline rebase and stale test evidence is discarded', async () => {
  const store = new MemoryStore();
  const drift = driftingWorkspace();
  const calls = [];
  const results = [
    completedRun('verified on old baseline', ['old-test-pass']),
    completedRun('verified after rebase', ['fresh-test-pass'])
  ];
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: drift.manager,
    processRunner: { run: async (input) => { calls.push(structuredClone(input)); return results.shift(); } },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3
  });

  const t = task();
  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'completed');
  assert.equal(result.baseSha, BASE_A);
  assert.equal(result.publicationBaseSha, BASE_B);
  assert.equal(calls.length, 2);
  assert.equal(drift.sealCalls, 2);
  assert.equal(calls[1].context.git.baseSha, BASE_A);
  assert.equal(calls[1].context.git.publicationBaseSha, BASE_B);
  assert.deepEqual(calls[1].context.tests, []);
  assert.match(calls[1].context.nextStep, /Re-run the relevant verification\/tests/u);

  const key = `run.owner/queue#${t.issueNumber}.${t.revision}`;
  const state = await store.get(key);
  assert.equal(state.stage, 'completed');
  assert.deepEqual(state.prior.tests, ['fresh-test-pass']);
  assert.equal(state.workspace.baseSha, BASE_A);
  assert.equal(state.workspace.publicationBaseSha, BASE_B);
  assert.deepEqual(state.workspace.taskBranchKnownRemoteHeads, []);
  assert.equal(state.baselineReconciliation.history.length, 1);
});

test('restart from publishing rechecks baseline and re-enters verification before push', async () => {
  const store = new MemoryStore();
  const t = task();
  const runId = `pp-${t.issueNumber}-${t.revision.slice(0, 16)}`;
  const key = `run.owner/queue#${t.issueNumber}.${t.revision}`;
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
  const stale = snapshot(workspace, { headSha: HEAD_A });
  await store.set(key, {
    version: 1,
    runId,
    task: t,
    stage: 'publishing',
    turn: 1,
    turnLimit: 3,
    createdAt: new Date().toISOString(),
    prior: priorState(stale, ['stale-pre-crash-test']),
    workspace: structuredClone(workspace),
    finalSnapshot: stale,
    lastFeedbackCommentId: 0,
    publication: { published: false },
    transientRetry: null
  });

  let seals = 0;
  let runs = 0;
  let pushes = 0;
  const workspaceManager = {
    async prepareRun(_task, _runId, resume = {}) {
      workspace.baseSha = resume.baseSha;
      workspace.publicationBaseSha = resume.publicationBaseSha;
      workspace.taskBranchKnownRemoteHeads = [...(resume.taskBranchKnownRemoteHeads ?? [])];
      return workspace;
    },
    async snapshot() { return snapshot(workspace, { headSha: workspace.publicationBaseSha === BASE_A ? HEAD_A : HEAD_B }); },
    async validate() { return snapshot(workspace, { headSha: workspace.publicationBaseSha === BASE_A ? HEAD_A : HEAD_B }); },
    async sealCandidate() {
      seals += 1;
      if (seals === 1) {
        workspace.publicationBaseSha = BASE_B;
        throw new BaselineReverificationRequiredError('baseline advanced while publication was interrupted', {
          changed: true,
          fromBaseSha: BASE_A,
          toBaseSha: BASE_B,
          fromHeadSha: HEAD_A,
          toHeadSha: HEAD_B
        });
      }
      return snapshot(workspace, { headSha: HEAD_B });
    },
    async publishTaskBranch() { pushes += 1; return { branch: BRANCH, headSha: HEAD_B }; }
  };
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager,
    processRunner: { run: async () => { runs += 1; return completedRun('fresh verification after restart', ['fresh-post-restart-test']); } },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3,
    autoPushTaskBranches: true
  });

  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'completed');
  assert.equal(result.published, true);
  assert.equal(result.publicationBaseSha, BASE_B);
  assert.equal(seals, 2);
  assert.equal(runs, 1);
  assert.equal(pushes, 1);
  const state = await store.get(key);
  assert.deepEqual(state.prior.tests, ['fresh-post-restart-test']);
  assert.equal(state.workspace.baseSha, BASE_A);
  assert.equal(state.workspace.publicationBaseSha, BASE_B);
  assert.deepEqual(state.workspace.taskBranchKnownRemoteHeads, [HEAD_A]);
});

test('clean local HEAD drift after verification clears stale evidence and publishes only the reverified head', async () => {
  const store = new MemoryStore();
  const t = task();
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
  const stale = snapshot(workspace, { headSha: HEAD_A });
  const key = await seedPublishingRun(store, t, workspace, stale, { tests: ['stale-local-head-test'] });
  const runnerCalls = [];
  const publicationCalls = [];
  let seals = 0;
  const workspaceManager = {
    async prepareRun(_task, _runId, resume = {}) {
      workspace.baseSha = resume.baseSha;
      workspace.publicationBaseSha = resume.publicationBaseSha;
      workspace.taskBranchKnownRemoteHeads = [...(resume.taskBranchKnownRemoteHeads ?? [])];
      return workspace;
    },
    async snapshot() { return snapshot(workspace, { headSha: HEAD_B }); },
    async validate() { return snapshot(workspace, { headSha: HEAD_B }); },
    async sealCandidate() { seals += 1; return snapshot(workspace, { headSha: HEAD_B }); },
    async publishTaskBranch(_workspace, options) {
      publicationCalls.push(structuredClone(options));
      return { branch: BRANCH, headSha: options.expectedHeadSha };
    }
  };
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager,
    processRunner: {
      run: async (input) => {
        runnerCalls.push(structuredClone(input));
        return completedRun('fresh verification after local HEAD drift', ['fresh-local-head-test']);
      }
    },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3,
    autoPushTaskBranches: true
  });

  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'completed');
  assert.equal(result.headSha, HEAD_B);
  assert.equal(result.published, true);
  assert.equal(runnerCalls.length, 1);
  assert.deepEqual(runnerCalls[0].context.tests, []);
  assert.equal(runnerCalls[0].context.git.headSha, HEAD_B);
  assert.match(runnerCalls[0].context.nextStep, /managed candidate changed after verification/i);
  assert.equal(seals, 1);
  assert.deepEqual(publicationCalls, [{ expectedHeadSha: HEAD_B }]);

  const state = await store.get(key);
  assert.equal(state.turn, 2);
  assert.equal(state.finalSnapshot.headSha, HEAD_B);
  assert.deepEqual(state.prior.tests, ['fresh-local-head-test']);
});

test('dirty worktree after verification invalidates stale evidence before sealing or publication', async () => {
  const store = new MemoryStore();
  const t = task();
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
  const stale = snapshot(workspace, { headSha: HEAD_A });
  const key = await seedPublishingRun(store, t, workspace, stale, { tests: ['stale-dirty-test'] });
  let snapshotCalls = 0;
  let seals = 0;
  let pushes = 0;
  const workspaceManager = {
    async prepareRun() { return workspace; },
    async snapshot() {
      snapshotCalls += 1;
      return snapshot(workspace, { headSha: HEAD_A, dirty: snapshotCalls === 1 });
    },
    async validate() { return snapshot(workspace, { headSha: HEAD_A, dirty: false }); },
    async sealCandidate() { seals += 1; return snapshot(workspace, { headSha: HEAD_A, dirty: false }); },
    async publishTaskBranch(_workspace, options) {
      pushes += 1;
      return { branch: BRANCH, headSha: options.expectedHeadSha };
    }
  };
  let runs = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager,
    processRunner: {
      run: async (input) => {
        runs += 1;
        assert.equal(seals, 0);
        assert.equal(pushes, 0);
        assert.deepEqual(input.context.tests, []);
        assert.match(input.context.nextStep, /managed candidate changed after verification/i);
        return completedRun('fresh verification after dirty drift', ['fresh-dirty-test']);
      }
    },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3,
    autoPushTaskBranches: true
  });

  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'completed');
  assert.equal(runs, 1);
  assert.equal(seals, 1);
  assert.equal(pushes, 1);
  const state = await store.get(key);
  assert.deepEqual(state.prior.tests, ['fresh-dirty-test']);
});

test('deterministic local candidate drift consumes the next bounded verification attempt before replay', async () => {
  const store = new MemoryStore();
  const plan = controllerPlanFixture();
  const t = task({ controllerPlan: plan });
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
  const stale = snapshot(workspace, { headSha: HEAD_A });
  const key = await seedPublishingRun(store, t, workspace, stale, {
    turn: 1,
    turnLimit: 3,
    tests: ['stale-deterministic-test']
  });
  let executions = 0;
  const publicationCalls = [];
  const workspaceManager = {
    async prepareRun() { return workspace; },
    async snapshot() { return snapshot(workspace, { headSha: HEAD_B }); },
    async validate() { return snapshot(workspace, { headSha: HEAD_B }); },
    async sealCandidate() { return snapshot(workspace, { headSha: HEAD_B }); },
    async publishTaskBranch(_workspace, options) {
      publicationCalls.push(structuredClone(options));
      return { branch: BRANCH, headSha: options.expectedHeadSha };
    }
  };
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager,
    processRunner: { run: async () => { throw new Error('model must not run for controller plan'); } },
    controllerPlanExecutor: {
      async execute({ state, workspace: activeWorkspace }) {
        executions += 1;
        assert.equal(state.turn, 2);
        assert.deepEqual(state.prior.tests, []);
        return {
          snapshot: snapshot(activeWorkspace, { headSha: HEAD_B }),
          tests: [{ operation: 'fixture.verify', id: 'local-drift-reverify', exitCode: 0 }],
          summary: 'deterministic local-drift reverify'
        };
      }
    },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3,
    autoPushTaskBranches: true
  });

  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'completed');
  assert.equal(executions, 1);
  assert.deepEqual(publicationCalls, [{ expectedHeadSha: HEAD_B }]);
  const state = await store.get(key);
  assert.equal(state.turn, 2);
  assert.deepEqual(state.prior.tests, [{ operation: 'fixture.verify', id: 'local-drift-reverify', exitCode: 0 }]);
});

test('exhausted deterministic local-drift window checkpoints before replay or publication', async () => {
  const store = new MemoryStore();
  const plan = controllerPlanFixture();
  const t = task({ controllerPlan: plan });
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
  const stale = snapshot(workspace, { headSha: HEAD_A });
  const key = await seedPublishingRun(store, t, workspace, stale, {
    turn: 3,
    turnLimit: 3,
    tests: ['stale-exhausted-test']
  });
  let executions = 0;
  let seals = 0;
  let pushes = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: {
      async prepareRun() { return workspace; },
      async snapshot() { return snapshot(workspace, { headSha: HEAD_B }); },
      async validate() { return snapshot(workspace, { headSha: HEAD_B }); },
      async sealCandidate() { seals += 1; return snapshot(workspace, { headSha: HEAD_B }); },
      async publishTaskBranch() { pushes += 1; return { branch: BRANCH, headSha: HEAD_B }; }
    },
    processRunner: { run: async () => { throw new Error('model must not run for controller plan'); } },
    controllerPlanExecutor: {
      async execute() {
        executions += 1;
        throw new Error('exhausted deterministic verification must not replay');
      }
    },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3,
    autoPushTaskBranches: true
  });

  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'waiting-feedback');
  assert.equal(result.waiting, true);
  assert.equal(executions, 0);
  assert.equal(seals, 0);
  assert.equal(pushes, 0);
  const state = await store.get(key);
  assert.equal(state.stage, 'waiting-feedback');
  assert.deepEqual(state.prior.tests, []);
  assert.match(state.prior.blockers[0], /bounded 3-attempt deterministic reverification window/u);
});

test('deterministic controller plan re-executes after a successful baseline rebase', async () => {
  const store = new MemoryStore();
  const drift = driftingWorkspace();
  let executions = 0;
  const planExecutor = {
    async execute({ workspace }) {
      executions += 1;
      return {
        snapshot: snapshot(workspace, { headSha: workspace.publicationBaseSha === BASE_A ? HEAD_A : HEAD_B }),
        tests: [{ operation: 'fixture.verify', id: `verify-${executions}`, exitCode: 0 }],
        summary: `deterministic pass ${executions}`
      };
    }
  };
  const plan = controllerPlanFixture();
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: drift.manager,
    processRunner: { run: async () => { throw new Error('model must not run for controller plan'); } },
    controllerPlanExecutor: planExecutor,
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3
  });

  const result = await coordinator.executeTask(task({ controllerPlan: plan }));
  assert.equal(result.status, 'completed');
  assert.equal(result.baseSha, BASE_A);
  assert.equal(result.publicationBaseSha, BASE_B);
  assert.equal(executions, 2);
  assert.equal(drift.sealCalls, 2);
});

test('upstream history rewrite checkpoints instead of failing or looping', async () => {
  const store = new MemoryStore();
  const rewrite = new BaselineReconciliationError('publication baseline history was rewritten', {
    kind: 'upstream-history-rewrite',
    reconciliation: { fromBaseSha: BASE_A, toBaseSha: BASE_B, fromHeadSha: HEAD_A }
  });
  const drift = driftingWorkspace({ reconciliationError: rewrite });
  let runs = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: drift.manager,
    processRunner: { run: async () => { runs += 1; return completedRun('candidate complete', ['pass']); } },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3
  });

  const t = task();
  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'waiting-feedback');
  assert.equal(result.waiting, true);
  assert.equal(runs, 1);
  assert.equal(drift.sealCalls, 1);
  const state = await store.get(`run.owner/queue#${t.issueNumber}.${t.revision}`);
  assert.equal(state.stage, 'waiting-feedback');
  assert.match(state.prior.blockers[0], /cannot safely reconcile the publication baseline/u);
});

test('deterministic rebase conflict checkpoints without inventing conflict-resolution work', async () => {
  const store = new MemoryStore();
  const conflict = new BaselineReconciliationError('automatic baseline rebase conflicted', {
    kind: 'conflict',
    files: ['candidate.js'],
    reconciliation: { fromBaseSha: BASE_A, toBaseSha: BASE_B, fromHeadSha: HEAD_A }
  });
  const drift = driftingWorkspace({ reconciliationError: conflict });
  let executions = 0;
  const plan = controllerPlanFixture();
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: drift.manager,
    processRunner: { run: async () => { throw new Error('model must not run'); } },
    controllerPlanExecutor: {
      async execute({ workspace }) {
        executions += 1;
        return { snapshot: snapshot(workspace), tests: [], summary: 'plan complete' };
      }
    },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 3
  });

  const result = await coordinator.executeTask(task({ controllerPlan: plan }));
  assert.equal(result.status, 'waiting-feedback');
  assert.equal(executions, 1);
  assert.equal(drift.sealCalls, 1);
});
