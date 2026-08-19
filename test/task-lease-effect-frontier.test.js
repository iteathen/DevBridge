import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskLeaseLostError } from '../src/errors.js';
import { IssueStatusReporter } from '../src/github/issue-status-reporter.js';
import { ControllerPlanExecutor } from '../src/run/controller-plan-executor.js';
import { LeaseExecutionContext } from '../src/run/lease-execution-context.js';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function fixtureManager() {
  let fenced = false;
  return {
    fence() { fenced = true; },
    assertOwned(handle) {
      if (fenced) throw new TaskLeaseLostError('fixture lease fenced');
      return handle;
    },
  };
}

function fixtureExecutor(operationRegistry = { validate() {}, async execute() { throw new Error('unexpected operation'); } }) {
  return new ControllerPlanExecutor({
    operationRegistry,
    processRunner: { async run() { throw new Error('unexpected process'); } },
    workspaceManager: {
      async snapshot() { return { dirty: false, changedFiles: [] }; },
      async validate() { return { dirty: false, changedFiles: [] }; },
    },
  });
}

function emptyPlan(overrides = {}) {
  return {
    protocol: 'patch-poller/controller-plan-v1',
    files: [],
    operations: [],
    assertions: [],
    expectedChangedPaths: [],
    ...overrides,
  };
}

function memoryStateStore() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}

function statusRequest() {
  return {
    issueNumber: 49,
    runId: 'run-49',
    revision: 'a'.repeat(64),
    stage: 'RUNNING',
    summary: 'fixture status',
    capsule: { protocol: 'patch-poller/context-v1' },
    force: true,
  };
}

test('controller materialization cannot start after the active task lease is fenced', async () => {
  const worktreeDir = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-materialize-'));
  const manager = fixtureManager();
  const context = new LeaseExecutionContext({ taskLeaseManager: manager });
  const handle = { signal: new AbortController().signal };
  const content = 'lease-owned\n';
  const plan = emptyPlan({
    files: [{ path: 'owned.txt', scope: 'persistent', action: 'create', content, contentSha256: sha256(content) }],
    expectedChangedPaths: ['owned.txt'],
  });
  const state = {};
  let persists = 0;

  await assert.rejects(
    context.run(handle, () => fixtureExecutor().execute({
      plan,
      state,
      workspace: { worktreeDir, runId: 'run-materialize' },
      persist: async () => {
        persists += 1;
        if (persists === 2) manager.fence();
      },
    })),
    TaskLeaseLostError,
  );
  assert.equal(await exists(path.join(worktreeDir, 'owned.txt')), false);
});

test('controller scratch creation is wired to the active task lease guard', async () => {
  const worktreeDir = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-scratch-'));
  const manager = fixtureManager();
  const context = new LeaseExecutionContext({ taskLeaseManager: manager });
  const handle = { signal: new AbortController().signal };
  const state = {};
  let persists = 0;
  const registry = {
    validate() {},
    async execute(_operation, _params, operationContext) {
      await operationContext.scratch.directory('probe');
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  await assert.rejects(
    context.run(handle, () => fixtureExecutor(registry).execute({
      plan: emptyPlan({ operations: [{ id: 'probe', operation: 'fixture.probe', params: {} }] }),
      state,
      workspace: { worktreeDir, runId: 'run-scratch' },
      persist: async () => {
        persists += 1;
        if (persists === 3) manager.fence();
      },
    })),
    TaskLeaseLostError,
  );
  assert.equal(await exists(path.join(path.dirname(worktreeDir), '.patch-poller-scratch-run-scratch')), false);
});

test('fenced controller does not clean up task files after losing ownership', async () => {
  const worktreeDir = await mkdtemp(path.join(os.tmpdir(), 'pp-lease-cleanup-'));
  const manager = fixtureManager();
  const context = new LeaseExecutionContext({ taskLeaseManager: manager });
  const handle = { signal: new AbortController().signal };
  const content = 'ephemeral\n';
  const registry = {
    validate() {},
    async execute() {
      manager.fence();
      throw new TaskLeaseLostError('fixture lease moved during operation');
    },
  };

  await assert.rejects(
    context.run(handle, () => fixtureExecutor(registry).execute({
      plan: emptyPlan({
        files: [{ path: 'ephemeral.txt', scope: 'ephemeral', action: 'create', content, contentSha256: sha256(content) }],
        operations: [{ id: 'move-lease', operation: 'fixture.move-lease', params: {} }],
      }),
      state: {},
      workspace: { worktreeDir, runId: 'run-cleanup' },
      persist: async () => {},
    })),
    TaskLeaseLostError,
  );
  assert.equal(await exists(path.join(worktreeDir, 'ephemeral.txt')), true);
});

test('task status publication is skipped when the lease is already fenced', async () => {
  const manager = fixtureManager();
  const context = new LeaseExecutionContext({ taskLeaseManager: manager });
  const handle = { signal: new AbortController().signal };
  const stateStore = memoryStateStore();
  let requests = 0;
  const reporter = new IssueStatusReporter({
    client: { async request() { requests += 1; return { data: { id: 10 } }; } },
    stateStore,
    queueRepository: 'iteathen/PATCH-POLLER',
  });

  await context.run(handle, async () => {
    manager.fence();
    const result = await reporter.publish(statusRequest());
    assert.deepEqual(result, { published: false, commentId: null, reason: 'lease-lost' });
  });
  assert.equal(requests, 0);
  assert.equal(stateStore.values.size, 0);
});

test('status publication records local reconciliation evidence if ownership is lost during the remote effect', async () => {
  const manager = fixtureManager();
  const context = new LeaseExecutionContext({ taskLeaseManager: manager });
  const handle = { signal: new AbortController().signal };
  const stateStore = memoryStateStore();
  const reporter = new IssueStatusReporter({
    client: {
      async request() {
        manager.fence();
        return { data: { id: 77 } };
      },
    },
    stateStore,
    queueRepository: 'iteathen/PATCH-POLLER',
  });

  const result = await context.run(handle, () => reporter.publish(statusRequest()));
  assert.equal(result.published, true);
  assert.equal(result.commentId, 77);
  assert.equal(result.leaseLost, true);
  const recorded = stateStore.values.get('status.iteathen/PATCH-POLLER#49.run-49');
  assert.equal(recorded.commentId, 77);
  assert.equal(recorded.sequence, 1);
});
