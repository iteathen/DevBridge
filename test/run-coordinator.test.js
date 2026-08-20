import test from 'node:test';
import assert from 'node:assert/strict';
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

function task() {
  return {
    queueRepository: 'owner/queue',
    issueNumber: 7,
    actorId: '1',
    revision: 'b'.repeat(64),
    envelope: {
      target: { repository: 'owner/repo' },
      instructions: 'do it',
      preferredTool: 'fixture',
      context: { constraints: [] }
    }
  };
}

function snapshot({ dirty = true, headSha = '2'.repeat(40) } = {}) {
  return {
    branch: 'devbridge/issue-7-bbbbbbbbbbbb',
    baseSha: '1'.repeat(40),
    headSha,
    dirty,
    changedFiles: ['a.js'],
    unmergedFiles: [],
    status: dirty ? ' M a.js' : ''
  };
}

const profile = {
  executable: process.execPath,
  args: [],
  inputMode: 'stdin-json',
  timeoutMs: 1000,
  maxOutputBytes: 4096,
  environment: { pass: [], set: {} },
  sandbox: { enforcement: 'os', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' }
};

test('drives multiple turns, seals the candidate, and completes without requiring publication', async () => {
  const store = new MemoryStore();
  const calls = [];
  let sealCalls = 0;
  const workspaceManager = {
    prepareRun: async (_task, _runId, resume) => ({
      worktreeDir: '/managed/run',
      branch: snapshot().branch,
      baseRef: resume?.baseRef ?? 'origin/main',
      baseSha: resume?.baseSha ?? snapshot().baseSha
    }),
    snapshot: async () => snapshot(),
    validate: async () => snapshot(),
    sealCandidate: async () => { sealCalls += 1; return snapshot({ dirty: false, headSha: '3'.repeat(40) }); },
    publishTaskBranch: async () => { throw new Error('should not publish'); }
  };
  const results = [
    { result: { protocol: 'devbridge/result-v1', status: 'continue', summary: 'pass one', progress: [], tests: [], nextStep: 'again' }, resultParseError: null, exitCode: 0, timedOut: false, stdout: '', stderr: '' },
    { result: { protocol: 'devbridge/result-v1', status: 'complete', summary: 'done', progress: [], tests: ['unit pass'], nextStep: null }, resultParseError: null, exitCode: 0, timedOut: false, stdout: '', stderr: '' }
  ];
  const processRunner = { run: async (input) => { calls.push(input); return results.shift(); } };
  const reports = [];
  const statusReporter = { publish: async (value) => { reports.push(value); return { published: true }; } };
  const coordinator = new RunCoordinator({ stateStore: store, workspaceManager, processRunner, statusReporter, queueRepository: 'owner/queue', tools: { fixture: profile }, defaultTool: 'fixture', maxTurns: 3 });
  const result = await coordinator.executeTask(task());
  assert.equal(result.status, 'completed');
  assert.equal(result.published, false);
  assert.equal(result.headSha, '3'.repeat(40));
  assert.equal(calls.length, 2);
  assert.equal(sealCalls, 1);
  assert.ok(reports.some((entry) => entry.stage === 'COMPLETED'));
});

test('blocked runs consume only trusted matching feedback before resuming', async () => {
  const store = new MemoryStore();
  const workspaceManager = {
    prepareRun: async (_task, _runId, resume) => ({ worktreeDir: '/managed/run', branch: snapshot().branch, baseRef: resume?.baseRef ?? 'origin/main', baseSha: resume?.baseSha ?? snapshot().baseSha }),
    snapshot: async () => snapshot(),
    validate: async () => snapshot(),
    sealCandidate: async () => snapshot({ dirty: false, headSha: '3'.repeat(40) }),
    publishTaskBranch: async () => ({})
  };
  let runs = 0;
  const processRunner = { run: async () => { runs += 1; return runs === 1 ? { result: { protocol: 'devbridge/result-v1', status: 'blocked', summary: 'need choice', blocker: 'choice', progress: [], tests: [] }, resultParseError: null, exitCode: 0, timedOut: false, stdout: '', stderr: '' } : { result: { protocol: 'devbridge/result-v1', status: 'complete', summary: 'done', progress: [], tests: [] }, resultParseError: null, exitCode: 0, timedOut: false, stdout: '', stderr: '' }; } };
  let feedbackReady = false;
  const feedbackSource = { pollWaitingRun: async () => feedbackReady ? { highestCommentId: 9, feedback: { action: 'continue', instructions: 'use B', actorId: '1', commentId: 9 } } : { highestCommentId: 0, feedback: null } };
  const coordinator = new RunCoordinator({ stateStore: store, workspaceManager, processRunner, feedbackSource, queueRepository: 'owner/queue', tools: { fixture: profile }, defaultTool: 'fixture', maxTurns: 3 });
  assert.equal((await coordinator.executeTask(task())).status, 'waiting-feedback');
  assert.equal((await coordinator.executeTask(task())).status, 'waiting-feedback');
  assert.equal(runs, 1);
  feedbackReady = true;
  assert.equal((await coordinator.executeTask(task())).status, 'completed');
  assert.equal(runs, 2);
});

test('a resumed run passes its persisted immutable baseline back to the workspace manager', async () => {
  const store = new MemoryStore();
  const seenResume = [];
  const workspaceManager = {
    prepareRun: async (_task, _runId, resume) => { seenResume.push(resume); return { worktreeDir: '/managed/run', branch: snapshot().branch, baseRef: resume?.baseRef ?? 'origin/main', baseSha: resume?.baseSha ?? snapshot().baseSha }; },
    snapshot: async () => snapshot(),
    validate: async () => snapshot(),
    sealCandidate: async () => snapshot({ dirty: false, headSha: '3'.repeat(40) }),
    publishTaskBranch: async () => ({})
  };
  let count = 0;
  const processRunner = { run: async () => { count += 1; return count === 1 ? { result: { protocol: 'devbridge/result-v1', status: 'blocked', summary: 'hold', blocker: 'hold', progress: [], tests: [] }, resultParseError: null, exitCode: 0, timedOut: false, stdout: '', stderr: '' } : { result: { protocol: 'devbridge/result-v1', status: 'complete', summary: 'done', progress: [], tests: [] }, resultParseError: null, exitCode: 0, timedOut: false, stdout: '', stderr: '' }; } };
  let feedbackReady = false;
  const feedbackSource = { pollWaitingRun: async () => feedbackReady ? { highestCommentId: 4, feedback: { action: 'continue', instructions: 'resume', actorId: '1', commentId: 4 } } : { highestCommentId: 0, feedback: null } };
  const coordinator = new RunCoordinator({ stateStore: store, workspaceManager, processRunner, feedbackSource, queueRepository: 'owner/queue', tools: { fixture: profile }, defaultTool: 'fixture', maxTurns: 3 });
  await coordinator.executeTask(task());
  feedbackReady = true;
  await coordinator.executeTask(task());
  assert.equal(seenResume[1].baseSha, '1'.repeat(40));
  assert.equal(seenResume[1].baseRef, 'origin/main');
});

test('restart from publishing reconciles the sealed candidate without invoking the model again', async () => {
  const store = new MemoryStore();
  const t = task();
  const runId = `pp-${t.issueNumber}-${t.revision.slice(0, 16)}`;
  const key = `run.owner/queue#${t.issueNumber}.${t.revision}`;
  const sealed = snapshot({ dirty: false, headSha: '4'.repeat(40) });
  await store.set(key, {
    version: 1, runId, task: t, stage: 'publishing', turn: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    prior: { summary: null, decisions: [], progress: ['done'], changedFiles: ['a.js'], tests: [], git: { branch: sealed.branch, baseSha: sealed.baseSha, headSha: sealed.headSha, dirty: false }, blockers: [], nextStep: null, outputTail: null },
    workspace: { worktreeDir: '/managed/run', branch: sealed.branch, baseRef: 'origin/main', baseSha: sealed.baseSha }, finalSnapshot: sealed, lastFeedbackCommentId: 0, publication: { published: false }
  });
  let modelRuns = 0;
  let pushes = 0;
  const workspaceManager = {
    prepareRun: async (_task, _runId, resume) => ({ worktreeDir: '/managed/run', branch: sealed.branch, baseRef: resume.baseRef, baseSha: resume.baseSha }),
    snapshot: async () => sealed,
    validate: async () => sealed,
    sealCandidate: async () => sealed,
    publishTaskBranch: async () => { pushes += 1; return { branch: sealed.branch, headSha: sealed.headSha }; }
  };
  const coordinator = new RunCoordinator({ stateStore: store, workspaceManager, processRunner: { run: async () => { modelRuns += 1; throw new Error('model must not run'); } }, queueRepository: 'owner/queue', tools: { fixture: profile }, defaultTool: 'fixture', maxTurns: 3, autoPushTaskBranches: true });
  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'completed');
  assert.equal(result.published, true);
  assert.equal(modelRuns, 0);
  assert.equal(pushes, 1);
  assert.equal((await store.get(key)).stage, 'completed');
});

test('a newer task revision is deferred while an older revision of the same issue is still active', async () => {
  const store = new MemoryStore();
  const oldTask = task();
  const newTask = structuredClone(oldTask);
  newTask.revision = 'd'.repeat(64);
  const oldKey = `run.owner/queue#${oldTask.issueNumber}.${oldTask.revision}`;
  await store.set(oldKey, {
    version: 1,
    runId: `pp-${oldTask.issueNumber}-${oldTask.revision.slice(0, 16)}`,
    task: oldTask,
    stage: 'waiting-feedback',
    turn: 1,
    createdAt: new Date().toISOString(),
    prior: { summary: null, decisions: [], progress: [], changedFiles: [], tests: [], git: null, blockers: ['waiting'], nextStep: null, outputTail: null },
    publication: { published: false }
  });
  let prepared = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: { prepareRun: async () => { prepared += 1; throw new Error('must not prepare'); } },
    processRunner: { run: async () => { throw new Error('must not run'); } },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture'
  });
  const result = await coordinator.executeTask(newTask);
  assert.equal(result.status, 'deferred-active-revision');
  assert.equal(result.deferred, true);
  assert.equal(result.activeRevision, oldTask.revision);
  assert.equal(result.requestedRevision, newTask.revision);
  assert.equal(prepared, 0);
});

test('a configured coding adapter is not selected without remote or operator opt-in', async () => {
  let runs = 0;
  const requested = task();
  requested.envelope.preferredTool = null;
  const coordinator = new RunCoordinator({
    stateStore: new MemoryStore(),
    workspaceManager: { prepareRun: async () => { throw new Error('must not prepare'); } },
    processRunner: { run: async () => { runs += 1; throw new Error('must not run'); } },
    queueRepository: 'owner/queue',
    tools: { 'codex-fast': profile },
    defaultTool: null,
    modelAdaptersEnabled: true,
  });

  const result = await coordinator.executeTask(requested);
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /no locally configured coding tool/u);
  assert.equal(runs, 0);
});
