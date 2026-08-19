import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskLeaseLostError } from '../src/errors.js';
import { runCycle } from '../src/app/run-once.js';
import { RunCoordinator, runIdForTask } from '../src/run/run-coordinator.js';

const REVISION = 'a'.repeat(64);

function task() {
  return {
    queueRepository: 'iteathen/DevBridge',
    repository: 'iteathen/DevBridge',
    issueNumber: 49,
    revision: REVISION,
    envelope: { controllerPlan: {} },
  };
}

function cycleRuntime(overrides = {}) {
  return {
    config: {
      execution: { enabled: true },
      github: { queueRepository: 'iteathen/DevBridge', pollIntervalMs: 60_000 },
    },
    stateStore: { entries: async () => [] },
    rateBudget: {
      recommendedPollIntervalMs: (value) => value,
      snapshot: () => ({ remaining: 100 }),
    },
    toolInventory: null,
    toolInventoryProjector: null,
    toolOnboarding: null,
    taskSource: { poll: async () => ({ tasks: [task()], rejected: [], unchanged: false, pollIntervalMs: 60_000 }) },
    coordinator: { executeTask: async () => ({ runId: runIdForTask(task()), issueNumber: 49, status: 'completed' }) },
    taskLeaseManager: null,
    leaseExecutionContext: null,
    ...overrides,
  };
}

test('peer-held lease defers task before coordinator execution', async () => {
  let executions = 0;
  const runtime = cycleRuntime({
    coordinator: { executeTask: async () => { executions += 1; throw new Error('must not execute'); } },
    taskLeaseManager: {
      begin: async () => ({
        acquired: false,
        reason: 'held-by-peer',
        ownerAddress: `peer#${'b'.repeat(64)}`,
        expiresAt: '2026-08-19T04:00:00.000Z',
        epoch: 8,
        commitSha: 'c'.repeat(40),
      }),
    },
  });
  const result = await runCycle(runtime);
  assert.equal(executions, 0);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'deferred-lease');
  assert.equal(result.results[0].deferred, true);
  assert.match(result.results[0].lease.ownerAddress, /^peer#/u);
});

test('terminal task result releases its acquired lease after lease-scoped execution', async () => {
  const calls = [];
  const handle = {
    signal: new AbortController().signal,
    expiresAt: '2026-08-19T04:00:00.000Z',
    epoch: 1,
    commitSha: 'd'.repeat(40),
  };
  const runtime = cycleRuntime({
    taskLeaseManager: {
      begin: async () => ({ acquired: true, handle }),
      release: async (received) => {
        calls.push(['release', received]);
        return { released: true, commitSha: 'e'.repeat(40), epoch: 2 };
      },
      stopHeartbeat: () => {},
      retain: () => { throw new Error('must not retain terminal lease'); },
    },
    leaseExecutionContext: {
      run: async (received, callback) => {
        calls.push(['run', received]);
        return callback();
      },
    },
  });
  const result = await runCycle(runtime);
  assert.equal(calls[0][0], 'run');
  assert.equal(calls[1][0], 'release');
  assert.equal(result.results[0].status, 'completed');
  assert.equal(result.results[0].lease.released, true);
});

test('RunCoordinator preserves resumable state when a lease fence blocks an effect', async () => {
  const values = new Map();
  const stateStore = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async entries(prefix) { return [...values.entries()].filter(([key]) => key.startsWith(prefix)); },
  };
  const fence = new TaskLeaseLostError('lease lost before workspace preparation');
  const coordinator = new RunCoordinator({
    stateStore,
    workspaceManager: {
      prepareRun: async () => { throw fence; },
    },
    processRunner: { run: async () => { throw new Error('must not invoke worker'); } },
    controllerPlanExecutor: null,
    queueRepository: 'iteathen/DevBridge',
    tools: {},
    controllerPlansEnabled: true,
    modelAdaptersEnabled: false,
  });
  const currentTask = task();
  await assert.rejects(coordinator.executeTask(currentTask), TaskLeaseLostError);
  const key = `run.iteathen/DevBridge#49.${REVISION}`;
  const saved = await stateStore.get(key);
  assert.equal(saved.stage, 'preparing');
  assert.equal(saved.error, undefined);
  assert.equal(saved.leaseFence.classification, 'TaskLeaseLostError');
  assert.match(saved.leaseFence.message, /lease lost/u);
});
