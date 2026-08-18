import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeControllerPlan, controllerPlanDigest } from '../src/run/controller-plan.js';
import { ControllerPlanExecutor } from '../src/run/controller-plan-executor.js';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';

function basePlan(overrides = {}) {
  return {
    protocol: 'patch-poller/controller-plan-v1',
    files: [],
    operations: [],
    assertions: [],
    ...overrides
  };
}

test('normalizes a bounded controller plan and produces a stable digest', () => {
  const plan = normalizeControllerPlan(basePlan({
    baselineChannel: 'testing',
    files: [{ scope: 'persistent', action: 'create', path: 'src/a.mjs', content: 'export const x = 1;\n' }],
    operations: [{ id: 'syntax', operation: 'node.syntax-check', params: { path: 'src/a.mjs' } }],
    assertions: [{ kind: 'exit-equals', operation: 'syntax', value: 0 }]
  }));
  assert.equal(plan.baselineChannel, 'testing');
  assert.deepEqual(plan.expectedChangedPaths, ['src/a.mjs']);
  assert.match(plan.files[0].contentSha256, /^[0-9a-f]{64}$/u);
  assert.equal(controllerPlanDigest(plan), controllerPlanDigest(structuredClone(plan)));
});

test('rejects traversal, reserved paths, raw authority, duplicate file paths, and stale-unsafe replace', () => {
  assert.throws(() => normalizeControllerPlan(basePlan({ files: [{ path: '../escape', content: 'x' }] })), /traverse|normalized/u);
  assert.throws(() => normalizeControllerPlan(basePlan({ files: [{ path: '.git/config', content: 'x' }] })), /reserved/u);
  assert.throws(() => normalizeControllerPlan(basePlan({ command: 'rm -rf /' })), /forbidden controller authority/u);
  assert.throws(() => normalizeControllerPlan(basePlan({
    files: [{ path: 'a.txt', content: 'a' }, { path: 'a.txt', content: 'b' }]
  })), /duplicate file path/u);
  assert.throws(() => normalizeControllerPlan(basePlan({
    files: [{ action: 'replace', path: 'a.txt', content: 'b' }]
  })), /expectedSha256/u);
});

test('rejects operation authority fields and assertions that name unknown operations', () => {
  assert.throws(() => normalizeControllerPlan(basePlan({
    operations: [{ id: 'x', operation: 'node.run', params: { executable: '/bin/sh' } }]
  })), /forbidden controller authority/u);
  assert.throws(() => normalizeControllerPlan(basePlan({
    assertions: [{ kind: 'exit-equals', operation: 'missing', value: 0 }]
  })), /unknown operation/u);
});

test('generic controller executor materializes a multi-file project, runs Node tests, and removes ephemeral files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'patch-poller-controller-plan-'));
  try {
    const plan = normalizeControllerPlan(basePlan({
      files: [
        { scope: 'persistent', action: 'create', path: 'src/math.mjs', content: 'export function add(a, b) { return a + b; }\n' },
        { scope: 'ephemeral', action: 'create', path: 'test/generated.test.mjs', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n" }
      ],
      operations: [
        { id: 'syntax', operation: 'node.syntax-check', params: { path: 'src/math.mjs' } },
        { id: 'tests', operation: 'node.test', params: { paths: ['test/generated.test.mjs'] } }
      ],
      assertions: [
        { kind: 'exit-equals', operation: 'syntax', value: 0 },
        { kind: 'exit-equals', operation: 'tests', value: 0 },
        { kind: 'file-exists', path: 'test/generated.test.mjs' }
      ],
      expectedChangedPaths: ['src/math.mjs']
    }));
    const workspace = { worktreeDir: root, branch: 'fixture', baseSha: '1'.repeat(40) };
    const snapshot = () => ({ branch: 'fixture', baseSha: workspace.baseSha, headSha: workspace.baseSha, dirty: true, changedFiles: ['src/math.mjs'], unmergedFiles: [], status: '?? src/math.mjs' });
    const workspaceManager = { snapshot: async () => snapshot(), validate: async () => snapshot() };
    const executor = new ControllerPlanExecutor({
      operationRegistry: createCoreOperationRegistry(),
      processRunner: new DeterministicProcessRunner(),
      workspaceManager
    });
    const state = {};
    let persists = 0;
    const result = await executor.execute({ plan, state, workspace, persist: async () => { persists += 1; } });
    assert.match(await readFile(path.join(root, 'src', 'math.mjs'), 'utf8'), /function add/u);
    await assert.rejects(stat(path.join(root, 'test', 'generated.test.mjs')), { code: 'ENOENT' });
    assert.equal(result.tests.length, 2);
    assert.equal(result.tests.every((entry) => entry.exitCode === 0), true);
    assert.equal(state.controllerPlan.cleanup.leftovers.length, 0);
    assert.equal(state.controllerPlan.cleanup.verifiedAbsent, 1);
    assert.ok(persists >= 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
