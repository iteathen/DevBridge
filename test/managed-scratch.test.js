import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
  const scratch = new ManagedScratchTransaction({
    workspace: { worktreeDir, runId: 'run-1' },
    state,
    persist: async () => { persists += 1; },
  });
  const directory = await scratch.directory('cmake-release');
  assert.equal(path.dirname(scratch.root), path.dirname(worktreeDir));
  assert.equal(path.dirname(directory), scratch.root);
  assert.equal(directory.startsWith(`${worktreeDir}${path.sep}`), false);
  await writeFile(path.join(directory, 'artifact.bin'), 'fixture');
  const cleanup = await scratch.cleanup();
  assert.equal(cleanup.verifiedAbsent, 1);
  assert.deepEqual(cleanup.leftovers, []);
  assert.equal(await exists(directory), false);
  assert.ok(persists >= 5);
});

test('worker project mirror is disposable, reconstructable, and excludes Git/control-plane state', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-worker-mirror-'));
  const worktreeDir = path.join(parent, 'run-mirror');
  await mkdir(path.join(worktreeDir, 'src'), { recursive: true });
  await mkdir(path.join(worktreeDir, '.patch-poller'), { recursive: true });
  await writeFile(path.join(worktreeDir, '.git'), 'gitdir: outside-authority\n');
  await writeFile(path.join(worktreeDir, '.patch-poller', 'context.json'), 'secret-control-state');
  await writeFile(path.join(worktreeDir, 'src', 'value.mjs'), 'export const value = 7;\n');
  const state = { controllerPlan: { scratchLedger: [] } };
  const scratch = new ManagedScratchTransaction({ workspace: { worktreeDir, runId: 'run-mirror' }, state, persist: async () => {} });

  const mirror = await scratch.projectMirror();
  assert.equal(await readFile(path.join(mirror, 'src', 'value.mjs'), 'utf8'), 'export const value = 7;\n');
  assert.equal(await exists(path.join(mirror, '.git')), false);
  assert.equal(await exists(path.join(mirror, '.patch-poller')), false);
  assert.equal(state.controllerPlan.workerMirror.gitAdministrativeStateExposed, false);

  await writeFile(path.join(mirror, 'src', 'value.mjs'), 'worker tamper\n');
  assert.equal(await readFile(path.join(worktreeDir, 'src', 'value.mjs'), 'utf8'), 'export const value = 7;\n');
  const cleanup = await scratch.cleanup();
  assert.equal(cleanup.leftovers.length, 0);
  assert.equal(await exists(mirror), false);
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
