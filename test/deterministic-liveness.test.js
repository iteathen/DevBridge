import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { IssueStatusReporter } from '../src/github/issue-status-reporter.js';

function processEnvironment() {
  const pass = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE']
    : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP'];
  return { pass, set: {} };
}

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}

test('long deterministic process emits bounded liveness while GitHub status mutations stay coalesced', async () => {
  const events = [];
  const requests = [];
  const reporter = new IssueStatusReporter({
    client: {
      async request(method, requestPath, options) {
        requests.push({ method, requestPath, options });
        return { data: { id: 77 } };
      },
    },
    stateStore: memoryStore(),
    queueRepository: 'iteathen/DevBridge',
    progressIntervalMs: 60_000,
    maxCommentBytes: 48_000,
  });
  const runner = new DeterministicProcessRunner();
  const result = await runner.run({
    executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 140)'],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    maxOutputBytes: 8_192,
    environment: processEnvironment(),
    activityIntervalMs: 25,
    onActivity: async (activity) => {
      events.push(activity);
      await reporter.publish({
        issueNumber: 29,
        runId: 'pp-liveness-fixture',
        revision: 'a'.repeat(64),
        stage: 'RUNNING',
        summary: 'Long deterministic fixture is active.',
        capsule: {
          protocol: 'devbridge/context-v1',
          liveness: activity,
          progress: [],
          decisions: [],
          changedFiles: [],
          tests: [],
          blockers: [],
        },
      });
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(events[0].kind, 'started');
  assert.equal(events[0].processAlive, true);
  assert.ok(events.some((event) => event.kind === 'heartbeat'));
  assert.equal(events.at(-1).kind, 'finished');
  assert.equal(events.at(-1).processAlive, false);
  assert.ok(events.every((event) => Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0));
  assert.ok(events.every((event) => typeof event.deadlineAt === 'string' && event.timeoutMs === 5_000));
  assert.equal(requests.length, 1, 'repeated liveness events must edit/coalesce by status interval instead of spamming comments');
  assert.equal(requests[0].method, 'POST');
});
