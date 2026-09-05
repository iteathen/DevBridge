import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeControllerPlan, controllerPlanDigest } from '../src/run/controller-plan.js';
import { ControllerPlanExecutor } from '../src/run/controller-plan-executor.js';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';

function basePlan(overrides = {}) {
  return {
    protocol: 'devbridge/controller-plan-v1',
    files: [],
    operations: [],
    assertions: [],
    ...overrides,
  };
}

test('normalizes a bounded controller plan and produces a stable digest', () => {
  const plan = normalizeControllerPlan(basePlan({
    baselineChannel: 'testing',
    files: [{ scope: 'persistent', action: 'create', path: 'src/a.mjs', content: 'export const x = 1;\n' }],
    operations: [{ id: 'syntax', operation: 'node.syntax-check', params: { path: 'src/a.mjs' } }],
    assertions: [{ kind: 'exit-equals', operation: 'syntax', value: 0 }],
  }));
  assert.equal(plan.baselineChannel, 'testing');
  assert.deepEqual(plan.expectedChangedPaths, ['src/a.mjs']);
  assert.match(plan.files[0].contentSha256, /^[0-9a-f]{64}$/u);
  assert.equal(controllerPlanDigest(plan), controllerPlanDigest(structuredClone(plan)));
});

test('rejects traversal, reserved paths, raw authority, duplicate file paths, and stale-unsafe replace', () => {
  assert.throws(() => normalizeControllerPlan(basePlan({ files: [{ path: '../escape', content: 'x' }] })), /traverse|normalized/u);
  assert.throws(() => normalizeControllerPlan(basePlan({ files: [{ path: '.git/config', content: 'x' }] })), /reserved/u);
  assert.throws(() => normalizeControllerPlan(basePlan({ command: 'rm -rf /' })), /schema|forbidden controller authority/u);
  assert.throws(() => normalizeControllerPlan(basePlan({
    files: [{ path: 'a.txt', content: 'a' }, { path: 'a.txt', content: 'b' }],
  })), /duplicate file path/u);
  assert.throws(() => normalizeControllerPlan(basePlan({
    files: [{ action: 'replace', path: 'a.txt', content: 'b' }],
  })), /expectedSha256/u);
});

test('closed schema rejects unknown fields and recursively rejects nested authority data', () => {
  assert.throws(() => normalizeControllerPlan(basePlan({ faultInjection: { enabled: true } })), /schema|forbidden controller authority/u);
  assert.throws(() => normalizeControllerPlan(basePlan({ files: [{ path: 'a.txt', content: 'a', mode: '0777' }] })), /not part of the controller-plan schema/u);
  assert.throws(() => normalizeControllerPlan(basePlan({
    operations: [{ id: 'x', operation: 'toolchain.probe', params: { nested: { environment: { SECRET: 'x' } } } }],
  })), /forbidden controller authority/u);
  assert.throws(() => normalizeControllerPlan(basePlan({
    assertions: [{ kind: 'workspace-clean', value: true }],
  })), /not part of the controller-plan schema/u);
});

test('rejects operation authority fields and assertions that name unknown operations', () => {
  assert.throws(() => normalizeControllerPlan(basePlan({
    operations: [{ id: 'x', operation: 'node.test', params: { executable: '/bin/sh' } }],
  })), /forbidden controller authority/u);
  assert.throws(() => normalizeControllerPlan(basePlan({
    assertions: [{ kind: 'exit-equals', operation: 'missing', value: 0 }],
  })), /unknown operation/u);
});

test('contains-assertion diagnostics identify the expected marker without echoing operation output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-controller-diagnostic-'));
  try {
    const operationRegistry = {
      validate() {},
      async execute() {
        return {
          exitCode: 1,
          timedOut: false,
          outputTruncated: false,
          stdout: 'UNTRUSTED_OUTPUT:/guest/private/path SECRET_TOKEN=do-not-echo\n',
          stderr: 'UNTRUSTED_ERROR:C:\\guest\\private\\path API_KEY=do-not-echo\n',
          startedAt: null,
          finishedAt: null,
          lastOutputAt: null,
        };
      },
    };
    const workspace = { worktreeDir: root, branch: 'fixture', baseSha: '1'.repeat(40) };
    const workspaceManager = { snapshot: async () => ({ dirty: false }), validate: async () => ({ changedFiles: [] }) };
    const executor = new ControllerPlanExecutor({ operationRegistry, processRunner: {}, workspaceManager });
    const expected = 'DB153_STAGE:healthy\nNEXT';

    for (const stream of ['stdout', 'stderr']) {
      const plan = normalizeControllerPlan(basePlan({
        operations: [{ id: 'probe', operation: 'fixture.probe', params: {} }],
        assertions: [{ kind: `${stream}-contains`, operation: 'probe', value: expected }],
      }));
      await assert.rejects(
        () => executor.execute({ plan, state: {}, workspace, persist: async () => {} }),
        (error) => {
          assert.equal(error.message.includes(`${stream} missing marker "DB153_STAGE:healthy\\nNEXT"`), true);
          assert.equal(error.message.includes('UNTRUSTED_OUTPUT'), false);
          assert.equal(error.message.includes('SECRET_TOKEN'), false);
          assert.equal(error.message.includes('UNTRUSTED_ERROR'), false);
          assert.equal(error.message.includes('API_KEY'), false);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generic controller executor materializes a multi-file project, runs static Node inspection, and removes ephemeral files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-controller-plan-'));
  try {
    const plan = normalizeControllerPlan(basePlan({
      files: [
        { scope: 'persistent', action: 'create', path: 'src/math.mjs', content: 'export function add(a, b) { return a + b; }\n' },
        { scope: 'ephemeral', action: 'create', path: 'test/generated.test.mjs', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture', () => assert.equal(1, 1));\n" },
      ],
      operations: [
        { id: 'syntax', operation: 'node.syntax-check', params: { path: 'src/math.mjs' } },
      ],
      assertions: [
        { kind: 'exit-equals', operation: 'syntax', value: 0 },
        { kind: 'file-exists', path: 'test/generated.test.mjs' },
      ],
      expectedChangedPaths: ['src/math.mjs'],
    }));
    const workspace = { worktreeDir: root, branch: 'fixture', baseSha: '1'.repeat(40) };
    const snapshot = () => ({ branch: 'fixture', baseSha: workspace.baseSha, headSha: workspace.baseSha, dirty: true, changedFiles: ['src/math.mjs'], unmergedFiles: [], status: '?? src/math.mjs' });
    const workspaceManager = { snapshot: async () => snapshot(), validate: async () => snapshot() };
    const executor = new ControllerPlanExecutor({
      operationRegistry: createCoreOperationRegistry(),
      processRunner: new DeterministicProcessRunner(),
      workspaceManager,
    });
    const state = {};
    let persists = 0;
    const result = await executor.execute({ plan, state, workspace, persist: async () => { persists += 1; } });
    assert.match(await readFile(path.join(root, 'src', 'math.mjs'), 'utf8'), /function add/u);
    await assert.rejects(stat(path.join(root, 'test', 'generated.test.mjs')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(root, 'test')), { code: 'ENOENT' });
    assert.equal(result.tests.length, 1);
    assert.equal(result.tests.every((entry) => entry.exitCode === 0), true);
    assert.equal(state.controllerPlan.cleanup.leftovers.length, 0);
    assert.equal(state.controllerPlan.cleanup.verifiedAbsent, 2);
    assert.ok(persists >= 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ephemeral cleanup preserves a parent directory that existed before materialization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-controller-parent-'));
  try {
    await mkdir(path.join(root, 'existing'));
    const plan = normalizeControllerPlan(basePlan({
      files: [{ scope: 'ephemeral', action: 'create', path: 'existing/value.txt', content: 'temporary\n' }],
      expectedChangedPaths: [],
    }));
    const workspace = { worktreeDir: root, branch: 'fixture', baseSha: '1'.repeat(40) };
    const workspaceManager = { snapshot: async () => ({ dirty: false }), validate: async () => ({ changedFiles: [] }) };
    const state = {};
    await new ControllerPlanExecutor({
      operationRegistry: createCoreOperationRegistry(),
      processRunner: new DeterministicProcessRunner(),
      workspaceManager,
    }).execute({ plan, state, workspace, persist: async () => {} });

    assert.equal((await stat(path.join(root, 'existing'))).isDirectory(), true);
    await assert.rejects(stat(path.join(root, 'existing', 'value.txt')), { code: 'ENOENT' });
    assert.deepEqual(state.controllerPlan.cleanupLedger.map((entry) => entry.kind), ['file']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ephemeral cleanup refuses unexpected directory content without recursive deletion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-controller-nonempty-'));
  try {
    const plan = normalizeControllerPlan(basePlan({
      files: [{ scope: 'ephemeral', action: 'create', path: 'isolated/value.txt', content: 'temporary\n' }],
      operations: [{ id: 'mutate', operation: 'fixture.mutate', params: {} }],
      expectedChangedPaths: [],
    }));
    const operationRegistry = {
      validate() {},
      async execute(_name, _params, context) {
        await writeFile(path.join(context.projectDir, 'isolated', 'unplanned.txt'), 'preserve\n', 'utf8');
        return { exitCode: 0, timedOut: false, outputTruncated: false, stdout: '', stderr: '' };
      },
    };
    const workspace = { worktreeDir: root, branch: 'fixture', baseSha: '1'.repeat(40) };
    const workspaceManager = { snapshot: async () => ({ dirty: true }), validate: async () => ({ changedFiles: [] }) };
    const state = {};
    await assert.rejects(
      () => new ControllerPlanExecutor({ operationRegistry, processRunner: {}, workspaceManager })
        .execute({ plan, state, workspace, persist: async () => {} }),
      /cleanup directory could not be removed exactly: isolated/u,
    );

    assert.equal(await readFile(path.join(root, 'isolated', 'unplanned.txt'), 'utf8'), 'preserve\n');
    await assert.rejects(stat(path.join(root, 'isolated', 'value.txt')), { code: 'ENOENT' });
    assert.equal(state.controllerPlan.cleanupLedger.find((entry) => entry.kind === 'directory').state, 'cleanup-planned');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
