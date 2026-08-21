import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedScratchTransaction } from '../src/runtime/managed-scratch.js';
import { DeterministicFaultInjector, FaultInjectionError } from '../src/runtime/fault-injector.js';

async function exists(candidate) {
  try { await stat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

test('managed scratch is a durable sibling transaction outside the Git worktree', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-scratch-'));
  const worktreeDir = path.join(parent, 'run-1');
  await mkdir(worktreeDir);
  const state = { controllerPlan: { scratchLedger: [] } };
  let persists = 0;
  const environmentCleanup = [];
  const scratch = new ManagedScratchTransaction({
    workspace: { worktreeDir, runId: 'run-1' },
    state,
    persist: async () => { persists += 1; },
    environmentCleanup: async ({ id }) => { environmentCleanup.push(id); return { verifiedAbsent: true }; },
  });
  const argument = await scratch.argument('cmake-release');
  const directory = argument.localPath;
  assert.deepEqual(argument, { kind: 'managed-scratch', name: 'cmake-release', localPath: directory });
  assert.equal(path.dirname(scratch.root), path.dirname(worktreeDir));
  assert.equal(path.dirname(directory), scratch.root);
  assert.equal(directory.startsWith(`${worktreeDir}${path.sep}`), false);
  await writeFile(path.join(directory, 'artifact.bin'), 'fixture');
  const cleanup = await scratch.cleanup();
  assert.equal(cleanup.verifiedAbsent, 1);
  assert.deepEqual(cleanup.leftovers, []);
  assert.equal(cleanup.environmentVerifiedAbsent, 1);
  assert.deepEqual(environmentCleanup, ['cmake-release']);
  assert.equal(await exists(directory), false);
  assert.ok(persists >= 5);
  const recreated = await scratch.directory('cmake-release');
  await writeFile(path.join(recreated, 'artifact.bin'), 'new fixture');
  await scratch.cleanup();
  assert.deepEqual(environmentCleanup, ['cmake-release', 'cmake-release']);
});

test('interrupted scratch cleanup leaves durable intent and safely reconciles on retry', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-scratch-fault-'));
  const worktreeDir = path.join(parent, 'run-2');
  await mkdir(worktreeDir);
  const state = { controllerPlan: { scratchLedger: [] } };
  const faults = new DeterministicFaultInjector({
    enabled: true,
    rules: [{ id: 'interrupt-cleanup', point: 'scratch.cleanup.before-remove', action: 'interrupt', occurrence: 1 }],
  });
  const scratch = new ManagedScratchTransaction({ workspace: { worktreeDir, runId: 'run-2' }, state, persist: async () => {}, faultInjector: faults });
  const directory = await scratch.directory('native-probe');
  await writeFile(path.join(directory, 'artifact.bin'), 'fixture');
  await assert.rejects(() => scratch.cleanup(), FaultInjectionError);
  assert.equal(state.controllerPlan.scratchLedger[0].state, 'cleanup-planned');
  assert.equal(await exists(directory), true);
  const cleanup = await scratch.cleanup();
  assert.equal(cleanup.verifiedAbsent, 1);
  assert.equal(await exists(directory), false);
});

test('failed environment cleanup preserves durable intent and reconciles before local removal', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-scratch-environment-'));
  const worktreeDir = path.join(parent, 'run-3');
  await mkdir(worktreeDir);
  const state = { controllerPlan: { scratchLedger: [] } };
  let attempts = 0;
  const scratch = new ManagedScratchTransaction({
    workspace: { worktreeDir, runId: 'run-3' },
    state,
    persist: async () => {},
    environmentCleanup: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('environment unavailable');
      return { verifiedAbsent: true };
    },
  });
  const directory = await scratch.directory('cmake-debug');
  await writeFile(path.join(directory, 'artifact.bin'), 'fixture');
  await assert.rejects(() => scratch.cleanup(), /environment unavailable/u);
  assert.equal(state.controllerPlan.scratchLedger[0].state, 'cleanup-planned');
  assert.equal(state.controllerPlan.scratchLedger[0].environmentState, undefined);
  assert.equal(await exists(directory), true);
  const cleanup = await scratch.cleanup();
  assert.equal(cleanup.environmentVerifiedAbsent, 1);
  assert.equal(await exists(directory), false);
});
