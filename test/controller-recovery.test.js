import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeControllerPlan } from '../src/run/controller-plan.js';
import { ControllerPlanExecutor } from '../src/run/controller-plan-executor.js';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { DeterministicFaultInjector, FaultInjectionError } from '../src/runtime/fault-injector.js';

async function exists(candidate) {
  try { await stat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function plan(overrides = {}) {
  return normalizeControllerPlan({
    protocol: 'devbridge/controller-plan-v1',
    files: [],
    operations: [],
    assertions: [],
    ...overrides,
  });
}

function workspaceManager(changedFiles) {
  const snapshot = {
    branch: 'fixture',
    baseSha: '1'.repeat(40),
    headSha: '1'.repeat(40),
    dirty: changedFiles.length > 0,
    changedFiles,
    unmergedFiles: [],
    status: '',
  };
  return { snapshot: async () => snapshot, validate: async () => snapshot };
}

test('post-effect interruption reconciles a persistent file by digest on restart', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-file-recovery-'));
  const worktreeDir = path.join(parent, 'run-file');
  await mkdir(worktreeDir);
  const faults = new DeterministicFaultInjector({
    enabled: true,
    rules: [{ id: 'after-write', point: 'file.after-effect', action: 'interrupt', occurrence: 1 }],
  });
  const executor = new ControllerPlanExecutor({
    operationRegistry: createCoreOperationRegistry(),
    processRunner: new DeterministicProcessRunner({ faultInjector: faults }),
    workspaceManager: workspaceManager(['src/value.mjs']),
    faultInjector: faults,
  });
  const state = { runId: 'run-file' };
  const controllerPlan = plan({
    files: [{ path: 'src/value.mjs', content: 'export const value = 7;\n' }],
    expectedChangedPaths: ['src/value.mjs'],
  });
  await assert.rejects(() => executor.execute({
    plan: controllerPlan,
    state,
    workspace: { worktreeDir, runId: 'run-file' },
    persist: async () => {},
  }), FaultInjectionError);
  assert.equal(await readFile(path.join(worktreeDir, 'src', 'value.mjs'), 'utf8'), 'export const value = 7;\n');
  assert.equal(state.controllerPlan.files[0].state, 'planned');

  const result = await executor.execute({
    plan: controllerPlan,
    state,
    workspace: { worktreeDir, runId: 'run-file' },
    persist: async () => {},
  });
  assert.equal(result.snapshot.changedFiles[0], 'src/value.mjs');
  assert.equal(state.controllerPlan.files[0].state, 'applied');
  assert.equal(state.controllerPlan.files[0].reconciled, true);
});

test('interrupted ephemeral cleanup persists cleanup intent and finishes on retry', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-cleanup-recovery-'));
  const worktreeDir = path.join(parent, 'run-cleanup');
  await mkdir(worktreeDir);
  const faults = new DeterministicFaultInjector({
    enabled: true,
    rules: [{ id: 'cleanup', point: 'cleanup.before-remove', action: 'interrupt', occurrence: 1 }],
  });
  const executor = new ControllerPlanExecutor({
    operationRegistry: createCoreOperationRegistry(),
    processRunner: new DeterministicProcessRunner({ faultInjector: faults }),
    workspaceManager: workspaceManager([]),
    faultInjector: faults,
  });
  const state = { runId: 'run-cleanup' };
  const controllerPlan = plan({
    files: [{ scope: 'ephemeral', action: 'create', path: 'test/generated.test.mjs', content: 'export default true;\n' }],
    expectedChangedPaths: [],
  });
  await assert.rejects(() => executor.execute({
    plan: controllerPlan,
    state,
    workspace: { worktreeDir, runId: 'run-cleanup' },
    persist: async () => {},
  }), FaultInjectionError);
  const ephemeral = path.join(worktreeDir, 'test', 'generated.test.mjs');
  assert.equal(await exists(ephemeral), true);
  assert.equal(state.controllerPlan.cleanupLedger[0].state, 'cleanup-planned');

  await executor.execute({
    plan: controllerPlan,
    state,
    workspace: { worktreeDir, runId: 'run-cleanup' },
    persist: async () => {},
  });
  assert.equal(await exists(ephemeral), false);
  assert.equal(await exists(path.join(worktreeDir, 'test')), false);
  assert.equal(state.controllerPlan.cleanupLedger.length, 2);
  assert.equal(state.controllerPlan.cleanupLedger.every((entry) => entry.state === 'verified-absent'), true);
});

test('no-follow containment rejects an intermediate symlink or junction before a controller write', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-nofollow-'));
  const worktreeDir = path.join(parent, 'run-link');
  const outside = path.join(parent, 'outside');
  await mkdir(worktreeDir);
  await mkdir(outside);
  await symlink(outside, path.join(worktreeDir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const executor = new ControllerPlanExecutor({
    operationRegistry: createCoreOperationRegistry(),
    processRunner: new DeterministicProcessRunner(),
    workspaceManager: workspaceManager([]),
  });
  const controllerPlan = plan({ files: [{ path: 'link/escape.txt', content: 'nope\n' }], expectedChangedPaths: ['link/escape.txt'] });
  await assert.rejects(() => executor.execute({
    plan: controllerPlan,
    state: { runId: 'run-link' },
    workspace: { worktreeDir, runId: 'run-link' },
    persist: async () => {},
  }), /symbolic link|junction/u);
  assert.equal(await exists(path.join(outside, 'escape.txt')), false);
});
