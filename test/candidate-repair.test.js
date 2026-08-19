import test from 'node:test';
import assert from 'node:assert/strict';
import { CandidateValidationError } from '../src/errors.js';
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

const revision = 'a'.repeat(64);
const task = {
  queueRepository: 'owner/queue',
  issueNumber: 4,
  actorId: '1',
  revision,
  envelope: {
    target: { repository: 'owner/repo' },
    instructions: 'write one fixture',
    preferredTool: 'fixture',
    context: { constraints: [] }
  }
};
const branch = `devbridge/issue-4-${revision.slice(0, 12)}`;
const dirty = {
  branch,
  baseSha: '1'.repeat(40),
  headSha: '1'.repeat(40),
  dirty: true,
  changedFiles: ['fixture.txt'],
  unmergedFiles: [],
  status: '?? fixture.txt'
};
const clean = { ...dirty, headSha: '2'.repeat(40), dirty: false, status: '' };
const profile = {
  executable: process.execPath,
  args: [],
  inputMode: 'stdin-json',
  timeoutMs: 1000,
  maxOutputBytes: 4096,
  environment: { pass: [], set: {} },
  sandbox: { enforcement: 'os', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' }
};

test('candidate validation rejection returns to a bounded repair turn instead of looping in verifying', async () => {
  const store = new MemoryStore();
  const key = `run.owner/queue#4.${revision}`;
  await store.set(key, {
    version: 1,
    runId: `pp-4-${revision.slice(0, 16)}`,
    task,
    stage: 'verifying',
    turn: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspace: { worktreeDir: '/managed/run', branch, baseRef: 'origin/main', baseSha: dirty.baseSha },
    prior: {
      summary: null,
      decisions: [],
      progress: [],
      changedFiles: dirty.changedFiles,
      tests: [],
      git: { branch, baseSha: dirty.baseSha, headSha: dirty.headSha, dirty: true },
      blockers: [],
      nextStep: null,
      outputTail: null
    },
    lastFeedbackCommentId: 0,
    publication: { published: false }
  });

  let sealCalls = 0;
  let modelCalls = 0;
  const reports = [];
  const workspaceManager = {
    prepareRun: async () => ({ worktreeDir: '/managed/run', branch, baseRef: 'origin/main', baseSha: dirty.baseSha }),
    snapshot: async () => dirty,
    validate: async () => dirty,
    sealCandidate: async () => {
      sealCalls += 1;
      if (sealCalls === 1) throw new CandidateValidationError('staged candidate failed git diff --check: fixture.txt:1: trailing whitespace');
      return clean;
    },
    publishTaskBranch: async () => { throw new Error('push not expected'); }
  };
  const processRunner = {
    run: async ({ context }) => {
      modelCalls += 1;
      assert.match(context.blockers?.[0] ?? '', /candidate validation rejected/u);
      assert.match(context.nextStep ?? '', /Do not stage or commit/u);
      return {
        result: { protocol: 'devbridge/result-v1', status: 'complete', summary: 'repaired fixture', progress: [], tests: [] },
        resultParseError: null,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: ''
      };
    }
  };
  const statusReporter = { publish: async (entry) => { reports.push(entry); return { published: true }; } };
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager,
    processRunner,
    statusReporter,
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 4,
    autoPushTaskBranches: false
  });

  const result = await coordinator.executeTask(task);
  assert.equal(result.status, 'completed');
  assert.equal(modelCalls, 1);
  assert.equal(sealCalls, 2);
  assert.ok(reports.some((entry) => entry.stage === 'REPAIRING'));
  assert.ok(reports.some((entry) => entry.stage === 'COMPLETED'));
  const finalState = await store.get(key);
  assert.equal(finalState.stage, 'completed');
  assert.equal(finalState.prior.blockers.length, 0);
});
