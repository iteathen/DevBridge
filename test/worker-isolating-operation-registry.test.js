import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedScratchTransaction } from '../src/runtime/managed-scratch.js';
import { WorkerIsolatingOperationRegistry } from '../src/runtime/worker-isolating-operation-registry.js';

async function exists(candidate) {
  try { await stat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

test('repository-code operation receives disposable no-Git mirror while static inspection keeps authoritative project', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-worker-registry-'));
  const worktreeDir = path.join(parent, 'run-worker');
  await mkdir(path.join(worktreeDir, 'src'), { recursive: true });
  await writeFile(path.join(worktreeDir, '.git'), 'gitdir: authoritative\n');
  await writeFile(path.join(worktreeDir, 'src', 'value.txt'), 'authoritative\n');
  const state = { controllerPlan: { scratchLedger: [] } };
  const scratch = new ManagedScratchTransaction({ workspace: { worktreeDir, runId: 'run-worker' }, state, persist: async () => {} });
  const calls = [];
  const descriptors = [
    { name: 'static', executionClass: 'static-inspection' },
    { name: 'execute', executionClass: 'repository-code-executing' },
  ];
  const delegate = {
    has: (name) => descriptors.some((entry) => entry.name === name),
    names: () => descriptors.map((entry) => entry.name),
    describe: () => descriptors,
    validate: (_name, params) => params,
    execute: async (name, _params, context) => {
      calls.push({ name, projectDir: context.projectDir, authoritativeProjectDir: context.authoritativeProjectDir ?? null });
      if (name === 'execute') {
        assert.equal(await exists(path.join(context.projectDir, '.git')), false);
        await writeFile(path.join(context.projectDir, 'src', 'value.txt'), 'worker\n');
      }
      return { exitCode: 0 };
    },
  };
  const registry = new WorkerIsolatingOperationRegistry({ delegate });

  await registry.execute('static', {}, { projectDir: worktreeDir, scratch });
  await registry.execute('execute', {}, { projectDir: worktreeDir, scratch });
  assert.equal(calls[0].projectDir, worktreeDir);
  assert.notEqual(calls[1].projectDir, worktreeDir);
  assert.equal(calls[1].authoritativeProjectDir, worktreeDir);
  assert.equal(await readFile(path.join(worktreeDir, 'src', 'value.txt'), 'utf8'), 'authoritative\n');
  await scratch.cleanup();
});
