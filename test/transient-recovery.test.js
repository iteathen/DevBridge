import test from 'node:test';
import assert from 'node:assert/strict';
import { RunCoordinator } from '../src/run/run-coordinator.js';
import { TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE, transientRecoveryDiagnosticProfile } from '../src/runtime/builtin-tool-profiles.js';
import { validateToolProfile } from '../src/runtime/cli-profile.js';

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
    issueNumber: 41,
    actorId: '1',
    revision: 'e'.repeat(64),
    envelope: {
      target: { repository: 'owner/repo' },
      instructions: 'durability test',
      requestedCapabilities: [],
      preferredTool: 'fixture',
      context: { constraints: [] }
    }
  };
}

function snapshot() {
  return {
    branch: 'devbridge/issue-41-eeeeeeeeeeee',
    baseSha: '1'.repeat(40),
    headSha: '1'.repeat(40),
    dirty: false,
    changedFiles: [],
    unmergedFiles: [],
    status: ''
  };
}

function workspaceManager() {
  return {
    prepareRun: async (_task, runId, resume) => ({
      worktreeDir: '/managed/run',
      branch: snapshot().branch,
      baseRef: resume?.baseRef ?? 'origin/main',
      baseSha: resume?.baseSha ?? snapshot().baseSha,
      runId
    }),
    snapshot: async () => snapshot(),
    validate: async () => snapshot(),
    sealCandidate: async () => snapshot(),
    publishTaskBranch: async () => ({ branch: snapshot().branch, headSha: snapshot().headSha })
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

function capacityFailure() {
  return {
    result: null,
    resultParseError: null,
    exitCode: 1,
    timedOut: false,
    stdout: '',
    stderr: 'ERROR: Selected model is at capacity. Please try a different model.'
  };
}

function completion() {
  return {
    result: {
      protocol: 'devbridge/result-v1',
      status: 'complete',
      summary: 'recovered',
      progress: [],
      tests: [{ name: 'recovery', status: 'pass' }],
      nextStep: null,
      blocker: null
    },
    resultParseError: null,
    exitCode: 0,
    timedOut: false,
    stdout: '',
    stderr: ''
  };
}

function prior() {
  return {
    summary: null,
    decisions: [],
    progress: [],
    changedFiles: [],
    tests: [],
    git: null,
    blockers: [],
    nextStep: null,
    outputTail: null
  };
}

test('built-in transient recovery profile is fixed, shell-free, and capability-minimal', () => {
  const diagnostic = transientRecoveryDiagnosticProfile();
  assert.equal(diagnostic.name, TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE);
  assert.equal(diagnostic.executable, TRANSIENT_RECOVERY_DIAGNOSTIC_PROFILE);
  assert.deepEqual(diagnostic.args, []);
  assert.deepEqual(diagnostic.environment.pass, []);
  const validated = validateToolProfile(diagnostic.name, diagnostic);
  assert.equal(validated.sandbox.outsideProjectRead, 'deny');
  assert.equal(validated.sandbox.outsideProjectWrite, false);
  assert.equal(validated.sandbox.network, 'deny');
});

test('transient capacity failures back off exponentially and then recover in the same run', async () => {
  const store = new MemoryStore();
  let now = Date.parse('2026-08-18T00:00:00.000Z');
  const sleeps = [];
  const runs = [capacityFailure(), capacityFailure(), completion()];
  let calls = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: workspaceManager(),
    processRunner: { run: async () => { calls += 1; return runs.shift(); } },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 4,
    nowMs: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; }
  });

  const result = await coordinator.executeTask(task());
  assert.equal(result.status, 'completed');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [5000, 10000]);
  const entries = await store.entries('run.owner/queue#');
  assert.equal(entries[0][1].transientRetry, null);
  assert.ok(entries[0][1].prior.progress.some((entry) => /retry 1 scheduled/u.test(entry)));
  assert.ok(entries[0][1].prior.progress.some((entry) => /retry 2 scheduled/u.test(entry)));
});

test('restart honors the persisted remaining transient backoff before invoking again', async () => {
  const store = new MemoryStore();
  const t = task();
  const key = `run.owner/queue#${t.issueNumber}.${t.revision}`;
  const runId = `pp-${t.issueNumber}-${t.revision.slice(0, 16)}`;
  const start = Date.parse('2026-08-18T00:00:00.000Z');
  await store.set(key, {
    version: 1,
    runId,
    task: t,
    stage: 'running',
    turn: 1,
    turnLimit: 4,
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start).toISOString(),
    prior: prior(),
    workspace: { worktreeDir: '/managed/run', branch: snapshot().branch, baseRef: 'origin/main', baseSha: snapshot().baseSha },
    lastFeedbackCommentId: 0,
    publication: { published: false },
    transientRetry: {
      classification: 'TRANSIENT',
      kind: 'model-capacity',
      attempts: 1,
      delayMs: 5000,
      notBefore: new Date(start + 5000).toISOString(),
      exhausted: false,
      lastAt: new Date(start).toISOString()
    }
  });

  let now = start + 2000;
  const sleeps = [];
  let calls = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: workspaceManager(),
    processRunner: { run: async () => { calls += 1; return completion(); } },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 4,
    nowMs: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; }
  });

  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, [3000]);
});

test('malformed persisted retry deadline fails before workspace or process effects', async () => {
  const store = new MemoryStore();
  const t = task();
  const key = `run.owner/queue#${t.issueNumber}.${t.revision}`;
  await store.set(key, {
    version: 1,
    runId: `pp-${t.issueNumber}-${t.revision.slice(0, 16)}`,
    task: t,
    stage: 'running',
    turn: 1,
    turnLimit: 4,
    createdAt: new Date().toISOString(),
    prior: prior(),
    workspace: { worktreeDir: '/managed/run', branch: snapshot().branch, baseRef: 'origin/main', baseSha: snapshot().baseSha },
    lastFeedbackCommentId: 0,
    publication: { published: false },
    transientRetry: { attempts: 1, notBefore: 'not-a-time' },
  });
  let effects = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: { prepareRun: async () => { effects += 1; } },
    processRunner: { run: async () => { effects += 1; } },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
  });

  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.classification, 'PolicyError');
  assert.match(result.error.message, /retry deadline is malformed/u);
  assert.equal(effects, 0);
});

test('persistent transient failure exhausts only the bounded window and does not sleep after the final attempt', async () => {
  const store = new MemoryStore();
  let now = Date.parse('2026-08-18T00:00:00.000Z');
  const sleeps = [];
  let calls = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: workspaceManager(),
    processRunner: { run: async () => { calls += 1; return capacityFailure(); } },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 2,
    nowMs: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; }
  });

  const result = await coordinator.executeTask(task());
  assert.equal(result.status, 'waiting-feedback');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [5000]);
  const entries = await store.entries('run.owner/queue#');
  assert.equal(entries[0][1].transientRetry.exhausted, true);
  assert.match(entries[0][1].prior.blockers[0], /Transient tool failure persisted/u);
});

test('trusted continuation at a turn-window frontier grants another bounded window without resetting turn identity', async () => {
  const store = new MemoryStore();
  const t = task();
  const key = `run.owner/queue#${t.issueNumber}.${t.revision}`;
  const runId = `pp-${t.issueNumber}-${t.revision.slice(0, 16)}`;
  await store.set(key, {
    version: 1,
    runId,
    task: t,
    stage: 'waiting-feedback',
    turn: 2,
    turnLimit: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prior: { ...prior(), blockers: ['window exhausted'] },
    workspace: { worktreeDir: '/managed/run', branch: snapshot().branch, baseRef: 'origin/main', baseSha: snapshot().baseSha },
    lastFeedbackCommentId: 0,
    publication: { published: false },
    transientRetry: { classification: 'TRANSIENT', kind: 'model-capacity', attempts: 2, delayMs: 0, notBefore: null, exhausted: true, lastAt: new Date().toISOString() }
  });

  let calls = 0;
  const feedbackSource = {
    pollWaitingRun: async () => ({
      highestCommentId: 9,
      feedback: { action: 'continue', instructions: 'continue within existing authority', actorId: '1', commentId: 9 }
    })
  };
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: workspaceManager(),
    processRunner: { run: async () => { calls += 1; return completion(); } },
    feedbackSource,
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 2
  });

  const result = await coordinator.executeTask(t);
  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
  const state = await store.get(key);
  assert.equal(state.turn, 3);
  assert.equal(state.turnLimit, 4);
  assert.equal(state.transientRetry, null);
});
