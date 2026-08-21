import test from 'node:test';
import assert from 'node:assert/strict';
import { RepositoryAdmissionError } from '../src/errors.js';
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

const profile = {
  executable: process.execPath,
  args: [],
  inputMode: 'stdin-json',
  timeoutMs: 1000,
  maxOutputBytes: 4096,
  environment: { pass: [], set: {} },
  sandbox: { enforcement: 'os', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' },
};

function task() {
  return {
    queueRepository: 'owner/queue',
    issueNumber: 136,
    actorId: '1',
    revision: 'c'.repeat(64),
    envelope: {
      target: { repository: 'owner/private' },
      instructions: 'verify exact candidate',
      preferredTool: 'fixture',
      context: { constraints: [] },
    },
  };
}

test('repository admission failure persists only typed sanitized summary while raw Git detail stays local', async () => {
  const store = new MemoryStore();
  const reports = [];
  const secret = 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const localPath = '/operator/private/workspace';
  const failure = new RepositoryAdmissionError(
    'repository admission failed during fetch: authentication; replace or reauthenticate the configured host Git credential',
    {
      phase: 'fetch',
      kind: 'authentication',
      repair: 'replace or reauthenticate the configured host Git credential',
      args: ['fetch', 'origin'],
      cwd: localPath,
      exitCode: 128,
      stderr: `fatal: Authentication failed for 'https://x-access-token:${secret}@github.com/owner/private.git/'`,
    }
  );
  let runnerCalls = 0;
  const coordinator = new RunCoordinator({
    stateStore: store,
    workspaceManager: {
      prepareRun: async () => { throw failure; },
      snapshot: async () => { throw new Error('snapshot should not run'); },
      validate: async () => { throw new Error('validate should not run'); },
      sealCandidate: async () => { throw new Error('seal should not run'); },
      publishTaskBranch: async () => { throw new Error('publish should not run'); },
    },
    processRunner: { run: async () => { runnerCalls += 1; throw new Error('runner should not run'); } },
    statusReporter: { publish: async (entry) => { reports.push(structuredClone(entry)); return { published: true }; } },
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
  });

  const result = await coordinator.executeTask(task());
  assert.equal(result.status, 'failed');
  assert.equal(result.error.classification, 'RepositoryAdmissionError');
  assert.equal(runnerCalls, 0);

  const entries = await store.entries('run.owner/queue#');
  assert.equal(entries.length, 1);
  const serialized = JSON.stringify(entries[0][1]);
  assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
  assert.doesNotMatch(serialized, /x-access-token/u);
  assert.doesNotMatch(serialized, new RegExp(localPath.replaceAll('/', '\\/'), 'u'));
  assert.match(entries[0][1].error.message, /during fetch: authentication/u);

  assert.equal(reports.at(-1).stage, 'FAILED');
  const remoteSummary = reports.at(-1).summary;
  assert.match(remoteSummary, /^RepositoryAdmissionError: repository admission failed during fetch: authentication/u);
  assert.doesNotMatch(remoteSummary, new RegExp(secret, 'u'));

  assert.match(failure.stderr, new RegExp(secret, 'u'));
  assert.equal(failure.cwd, localPath);
});
