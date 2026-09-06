import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/state/json-state-store.js';
import { IssueStatusReporter } from '../src/github/issue-status-reporter.js';
import { RunCoordinator, runIdForTask } from '../src/run/run-coordinator.js';
import { runCycle } from '../src/app/runtime-cycle.js';
import { LeaseExecutionContext } from '../src/run/lease-execution-context.js';

const task = { queueRepository: 'owner/queue', issueNumber: 7, revision: 'a'.repeat(64), actorId: '12', envelope: {
  target: { repository: 'owner/project' }, instructions: 'Prepare the requested project.', context: {},
  controllerPlan: { protocol: 'devbridge/controller-plan-v1', files: [], operations: [], assertions: [], expectedChangedPaths: [] },
} };

for (const beforeReporter of [false, true]) test(`normal cycle recovers terminal preparation failure after restart (before reporter: ${beforeReporter}) without rerun or log request`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-status-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  let online = false;
  let prepares = 0;
  let claims = 0;
  let releases = 0;
  let pollTasks = [task];
  const comments = [];
  const client = { async request(method, requestPath, options) {
    if (!online) throw new Error('GitHub temporarily unreachable');
    if (requestPath === '/graphql') return { data: { data: { viewer: { databaseId: 12 } } } };
    assert.equal(method, 'POST');
    comments.push(options.body.body);
    return { data: { id: 100 } };
  } };
  function runtime() {
    const stateStore = new JsonStateStore(file);
    const statusReporter = new IssueStatusReporter({ client, stateStore, queueRepository: 'owner/queue' });
    const manager = {
      async begin(bound) { assert.equal(bound.revision, task.revision); claims += 1; return { acquired: true, handle: { signal: new AbortController().signal } }; },
      assertOwned() {},
      async release() { releases += 1; return { released: true }; },
    };
    return {
      queueRepository: 'owner/queue', stateStore, statusReporter,
      config: { github: { pollIntervalMs: 60_000 }, execution: { enabled: true } },
      rateBudget: { recommendedPollIntervalMs: value => value, snapshot: () => ({}) },
      taskLeaseManager: manager, leaseExecutionContext: new LeaseExecutionContext({ taskLeaseManager: manager }),
      taskSource: { async poll() { return { tasks: pollTasks }; } },
      coordinator: new RunCoordinator({ stateStore, statusReporter, queueRepository: 'owner/queue', tools: {},
        workspaceManager: { async prepareRun() {
          prepares += 1;
          const error = new Error('Input transfer failed: selected environment is unavailable.');
          error.exitCode = 17;
          error.stderr = 'No qualified Linux environment exists for this task.';
          throw error;
        } }, processRunner: { async run() { assert.fail('repository execution must not occur'); } },
      }),
    };
  }
  const initial = runtime();
  if (beforeReporter) initial.statusReporter.publish = async () => { throw new Error('process interrupted before reporter persisted intent'); };
  const first = await runCycle(initial);
  assert.equal(first.results[0].status, 'failed');
  assert.equal(comments.length, 0);
  assert.equal(prepares, 1);
  pollTasks = [];
  online = true;
  const second = await runCycle(runtime());
  assert.equal(second.statusDeliveries[0].published, true);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /No qualified Linux environment exists/);
  assert.match(comments[0], /Attempt: 1; failing stage: preparing/);
  assert.match(comments[0], /Exit status: 17/);
  assert.equal(prepares, 1);
  assert.equal(claims, 2);
  assert.equal(releases, 2);
  await runCycle(runtime());
  assert.equal(comments.length, 1);
});

test('recovery cannot publish under a different task or a peer-held lease', async () => {
  let publishes = 0;
  const state = { task, runId: runIdForTask(task), stage: 'failed' };
  const runtime = {
    queueRepository: 'owner/queue',
    stateStore: { get: async () => state, entries: async () => [] },
    statusReporter: { pending: async () => [{ issueNumber: 7, runId: runIdForTask(task), revision: task.revision }], reconcile: async () => { publishes += 1; } },
    taskLeaseManager: { begin: async () => ({ acquired: false, reason: 'held-by-peer' }) },
    config: { github: { pollIntervalMs: 60_000 }, execution: { enabled: false } },
    rateBudget: { recommendedPollIntervalMs: value => value, snapshot: () => ({}) },
  };
  assert.equal((await runCycle(runtime)).statusDeliveries[0].status, 'deferred-lease');
  state.runId = 'wrong-run';
  assert.equal((await runCycle(runtime)).statusDeliveries[0].reason, 'task-correlation-unavailable');
  assert.equal(publishes, 0);
});

test('recovered progress does not clear the later terminal crash-recovery intent', async () => {
  const state = { task, runId: runIdForTask(task), stage: 'running' };
  let writes = 0;
  const runtime = {
    queueRepository: 'owner/queue',
    stateStore: { get: async () => state, entries: async () => [], set: async () => { writes += 1; } },
    statusReporter: { pending: async () => [{ issueNumber: 7, runId: state.runId, revision: task.revision }], reconcile: async () => ({ published: true }) },
    config: { github: { pollIntervalMs: 60_000 }, execution: { enabled: false } },
    rateBudget: { recommendedPollIntervalMs: value => value, snapshot: () => ({}) },
  };
  assert.equal((await runCycle(runtime)).statusDeliveries[0].published, true);
  assert.equal(state.statusDeliveryPending, undefined);
  assert.equal(writes, 0);
});
