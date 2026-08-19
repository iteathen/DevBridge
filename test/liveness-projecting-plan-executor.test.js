import test from 'node:test';
import assert from 'node:assert/strict';
import { LivenessProjectingPlanExecutor } from '../src/run/liveness-projecting-plan-executor.js';

function stateFixture() {
  return {
    runId: 'pp-29-liveness',
    turn: 1,
    task: {
      queueRepository: 'iteathen/DevBridge',
      issueNumber: 29,
      actorId: '1775584',
      revision: 'a'.repeat(64),
      envelope: {
        instructions: 'Exercise deterministic liveness projection.',
        target: { repository: 'iteathen/DevBridge' },
        context: {},
      },
    },
    prior: {
      summary: null,
      decisions: [],
      progress: [],
      changedFiles: [],
      tests: [],
      git: null,
      blockers: [],
      nextStep: null,
      outputTail: null,
      receipt: null,
      liveness: null,
    },
    controllerPlan: {
      operations: [{ id: 'test-op', operation: 'node.test', attempts: 2 }],
    },
  };
}

test('plan executor decorator durably persists and projects bounded liveness', async () => {
  const state = stateFixture();
  const persisted = [];
  const published = [];
  const delegateEvents = [];
  const delegate = {
    async execute(options) {
      await options.onLiveness({
        operationId: 'test-op',
        operation: 'node.test',
        kind: 'heartbeat',
        at: '2026-08-18T18:00:30.000Z',
        startedAt: '2026-08-18T18:00:00.000Z',
        elapsedMs: 30_123.9,
        lastOutputAt: '2026-08-18T18:00:20.000Z',
        deadlineAt: '2026-08-18T18:03:00.000Z',
        timeoutMs: 180_000,
        processAlive: true,
      });
      return { ok: true };
    },
  };
  const executor = new LivenessProjectingPlanExecutor({
    delegate,
    statusReporter: {
      async publish(value) { published.push(structuredClone(value)); return { published: true }; },
    },
  });

  const result = await executor.execute({
    state,
    workspace: { worktreeDir: '/unused' },
    persist: async () => { persisted.push(structuredClone(state.prior.liveness)); },
    onLiveness: async (activity) => { delegateEvents.push(activity.kind); },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(delegateEvents, ['heartbeat']);
  assert.equal(persisted.length, 1);
  assert.deepEqual(state.prior.liveness, {
    stage: 'deterministic-operation',
    operationId: 'test-op',
    operation: 'node.test',
    activity: 'heartbeat',
    startedAt: '2026-08-18T18:00:00.000Z',
    elapsedMs: 30_123,
    lastActivityAt: '2026-08-18T18:00:30.000Z',
    lastOutputAt: '2026-08-18T18:00:20.000Z',
    deadlineAt: '2026-08-18T18:03:00.000Z',
    timeoutMs: 180_000,
    attempt: 2,
    retryState: 'not-retrying',
    processAlive: true,
  });
  assert.equal(published.length, 1);
  assert.equal(published[0].stage, 'RUNNING');
  assert.equal(published[0].capsule.liveness.processAlive, true);
  assert.match(published[0].summary, /elapsed 31s/u);
});

test('status projection failure is recorded durably without failing deterministic work', async () => {
  const state = stateFixture();
  let persistCount = 0;
  const executor = new LivenessProjectingPlanExecutor({
    delegate: {
      async execute(options) {
        await options.onLiveness({
          operationId: 'test-op',
          operation: 'node.test',
          kind: 'started',
          at: '2026-08-18T18:00:00.000Z',
          startedAt: '2026-08-18T18:00:00.000Z',
          elapsedMs: 0,
          deadlineAt: '2026-08-18T18:03:00.000Z',
          timeoutMs: 180_000,
          processAlive: true,
        });
        return { ok: true };
      },
    },
    statusReporter: {
      async publish() { throw new Error('projection unavailable'); },
    },
  });

  const result = await executor.execute({
    state,
    persist: async () => { persistCount += 1; },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(persistCount, 2);
  assert.equal(state.statusError.name, 'Error');
  assert.match(state.statusError.message, /projection unavailable/u);
  assert.equal(state.prior.liveness.processAlive, true);
});
