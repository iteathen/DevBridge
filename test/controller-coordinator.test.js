import test from 'node:test';
import assert from 'node:assert/strict';
import { RunCoordinator } from '../src/run/run-coordinator.js';
import { normalizeControllerPlan, controllerPlanDigest } from '../src/run/controller-plan.js';

class MemoryStore {
  data = new Map();
  async get(key) { return structuredClone(this.data.get(key)); }
  async set(key, value) { this.data.set(key, structuredClone(value)); }
  async entries(prefix = '') { return [...this.data.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]); }
}

function planTask() {
  return {
    queueRepository: 'owner/queue',
    issueNumber: 33,
    actorId: '1',
    revision: 'e'.repeat(64),
    envelope: {
      target: { repository: 'owner/repo' },
      instructions: 'run deterministic plan',
      context: { handoff: 'handoff' },
      controllerPlan: normalizeControllerPlan({ protocol: 'patch-poller/controller-plan-v1' })
    }
  };
}

function cleanSnapshot() {
  return {
    branch: 'patchpoller/issue-33-eeeeeeeeeeee',
    baseSha: '1'.repeat(40),
    headSha: '1'.repeat(40),
    dirty: false,
    changedFiles: [],
    unmergedFiles: [],
    status: ''
  };
}

test('controller plans bypass coding models, bind an input receipt, and elide no-op publication', async () => {
  const store = new MemoryStore();
  const task = planTask();
  const reports = [];
  let modelRuns = 0;
  let pushes = 0;
  let planRuns = 0;
  const workspaceManager = {
    prepareRun: async (_task, _runId, resume) => ({
      worktreeDir: '/managed/run',
      branch: cleanSnapshot().branch,
      baseRef: 'origin/sol/foundation-bootstrap',
      baseSha: cleanSnapshot().baseSha,
      baselineChannel: resume.baselineChannel ?? 'testing'
    }),
    snapshot: async () => cleanSnapshot(),
    validate: async () => cleanSnapshot(),
    sealCandidate: async () => cleanSnapshot(),
    publishTaskBranch: async () => { pushes += 1; throw new Error('no-op branch must not publish'); }
  };
  const controllerPlanExecutor = {
    execute: async ({ state, persist }) => {
      planRuns += 1;
      state.controllerPlan = { phase: 'complete', cleanupLedger: [], cleanup: { verifiedAbsent: 0, leftovers: [] } };
      await persist();
      return { snapshot: cleanSnapshot(), tests: [], summary: 'deterministic complete' };
    }
  };
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager,
    processRunner: { run: async () => { modelRuns += 1; throw new Error('model must not run'); } },
    controllerPlanExecutor,
    statusReporter: { publish: async (value) => { reports.push(value); return { published: true }; } },
    queueRepository: 'owner/queue',
    tools: {},
    defaultTool: null,
    controllerPlansEnabled: true,
    modelAdaptersEnabled: false,
    autoPushTaskBranches: true
  });
  const result = await coordinator.executeTask(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.publicationSkipped, true);
  assert.equal(result.publicationReason, 'no-project-diff');
  assert.equal(modelRuns, 0);
  assert.equal(planRuns, 1);
  assert.equal(pushes, 0);
  const terminal = reports.findLast((entry) => entry.stage === 'COMPLETED');
  assert.equal(terminal.capsule.receipt.controllerPlanSha256, controllerPlanDigest(task.envelope.controllerPlan));
  assert.equal(terminal.capsule.receipt.taskRevision, task.revision);
  assert.equal(terminal.capsule.receipt.effectiveBaselineSha, cleanSnapshot().baseSha);
});

test('a non-plan task cannot invoke a coding model when local policy disables model adapters', async () => {
  const task = planTask();
  task.envelope.controllerPlan = null;
  task.envelope.preferredTool = 'fixture';
  let runs = 0;
  const coordinator = new RunCoordinator({
    stateStore: new MemoryStore(),
    workspaceManager: { prepareRun: async () => { throw new Error('must not prepare'); } },
    processRunner: { run: async () => { runs += 1; } },
    queueRepository: 'owner/queue',
    tools: { fixture: { executable: process.execPath } },
    defaultTool: 'fixture',
    modelAdaptersEnabled: false
  });
  const result = await coordinator.executeTask(task);
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /coding-model adapters are disabled/u);
  assert.equal(runs, 0);
});
