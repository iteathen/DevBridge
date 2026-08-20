import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFastHostRepositoryExecution } from '../src/app/fast-host-repository-execution.js';
import { createRuntimeExecutionContext } from '../src/app/runtime-execution.js';
import { REPOSITORY_EXECUTION_REQUEST_PROTOCOL } from '../src/runtime/repository-execution.js';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { normalizeControllerPlan } from '../src/run/controller-plan.js';
import { ControllerPlanExecutor } from '../src/run/controller-plan-executor.js';

test('fast host execution runs in the managed worktree and round-trips transfers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-fast-root-'));
  const state = await mkdtemp(path.join(os.tmpdir(), 'db-fast-state-'));
  let output = null;
  const execution = createFastHostRepositoryExecution({
    stateDirectory: state,
    rootFor: async () => root,
    resolveTool: async () => ({ program: process.execPath, arguments: [] }),
  });

  assert.equal(execution.inspect().ready, true);
  const result = await execution.execute({
    protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
    operation: 'fast.smoke',
    scope: { repository: 'owner/project', repositoryId: '1', runId: 'run-1' },
    invocation: {
      tool: 'node',
      arguments: [
        '-e',
        "const fs=require('node:fs');const value=fs.readFileSync(process.argv[1],'utf8');fs.writeFileSync(process.argv[2],value.toUpperCase());fs.writeFileSync('changed.txt','ok');",
        { kind: 'input', name: 'source' },
        { kind: 'output', name: 'result' },
      ],
      workingDirectory: '.',
    },
    environment: {},
    transfers: [
      { name: 'source', direction: 'input', port: { read: async () => Buffer.from('working') } },
      { name: 'result', direction: 'output', port: { write: async (bytes) => { output = Buffer.from(bytes); } } },
    ],
    limits: { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
    stdin: null,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(output.toString('utf8'), 'WORKING');
  assert.equal(await readFile(path.join(root, 'changed.txt'), 'utf8'), 'ok');
  assert.equal(result.evidence.scope.runId, 'run-1');
});

test('submitted controller plan materializes code and runs Node tests through fast execution', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'db-fast-workspace-'));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'db-fast-plan-state-'));
  const worktree = path.join(workspaceRoot, 'worktrees', 'owner', 'project', 'run-1');
  await mkdir(worktree, { recursive: true });
  const runtimeExecution = await createRuntimeExecutionContext({
    config: {
      state: { directory: stateDirectory },
      workspace: { root: workspaceRoot },
      execution: { fastHost: true },
      tools: {},
    },
    workspaceManager: { worktreePath: () => worktree },
    gitClient: { run: async () => ({ stdout: '' }) },
    client: { request: async () => ({ data: { id: 1, full_name: 'owner/project' } }) },
  });
  const plan = normalizeControllerPlan({
    protocol: 'devbridge/controller-plan-v1',
    files: [{
      scope: 'persistent',
      action: 'create',
      path: 'test/remote.test.mjs',
      content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('remote plan',()=>assert.equal(2+2,4));\n",
    }],
    operations: [{ id: 'tests', operation: 'node.test', params: { paths: ['test/remote.test.mjs'] } }],
    assertions: [{ kind: 'exit-equals', operation: 'tests', value: 0 }],
  });
  const snapshot = () => ({
    branch: 'fixture', baseSha: '1'.repeat(40), headSha: '1'.repeat(40), dirty: true,
    changedFiles: ['test/remote.test.mjs'], unmergedFiles: [], status: '?? test/remote.test.mjs',
  });
  const executor = new ControllerPlanExecutor({
    operationRegistry: createCoreOperationRegistry(),
    processRunner: runtimeExecution.scope(new DeterministicProcessRunner({ repositoryExecution: runtimeExecution.repositoryExecution })),
    workspaceManager: { snapshot: async () => snapshot(), validate: async () => snapshot() },
  });
  const result = await executor.execute({
    plan,
    state: {},
    workspace: { worktreeDir: worktree, branch: 'fixture', baseSha: '1'.repeat(40) },
    persist: async () => {},
  });

  assert.equal(result.tests.length, 1);
  assert.equal(result.tests[0].exitCode, 0);
  assert.match(await readFile(path.join(worktree, 'test', 'remote.test.mjs'), 'utf8'), /remote plan/u);
});
