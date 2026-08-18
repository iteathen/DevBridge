import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeControllerPlan, controllerPlanDigest } from '../src/run/controller-plan.js';
import { ControllerPlanExecutor } from '../src/run/controller-plan-executor.js';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { createCoreOperationRegistry, DeterministicOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';

function basePlan(overrides = {}) {
  return {
    protocol: 'patch-poller/controller-plan-v1',
    files: [],
    operations: [],
    assertions: [],
    ...overrides,
  };
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function workspaceFixture(root, changedFiles = []) {
  const workspace = { worktreeDir: root, branch: 'fixture', baseSha: '1'.repeat(40) };
  const snapshot = () => ({
    branch: 'fixture', baseSha: workspace.baseSha, headSha: workspace.baseSha,
    dirty: changedFiles.length > 0, changedFiles: [...changedFiles], unmergedFiles: [],
    status: changedFiles.map((file) => ` M ${file}`).join('\n')
  });
  return { workspace, workspaceManager: { snapshot: async () => snapshot(), validate: async () => snapshot() } };
}

function verifiedTestSandbox(observed = []) {
  return {
    inspect: () => ({ provider: 'test-verified', configured: true, verified: true, verification: 'fixture' }),
    prepareSpawn: async ({ executable, args, cwd, environment, sandbox }) => {
      observed.push(structuredClone(sandbox));
      return { executable, args, cwd, environment, provider: 'test-verified' };
    },
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
  assert.throws(() => normalizeControllerPlan(basePlan({ files: [{ path: 'a.txt', content: 'a' }, { path: 'a.txt', content: 'b' }] })), /duplicate file path/u);
  assert.throws(() => normalizeControllerPlan(basePlan({ files: [{ action: 'replace', path: 'a.txt', content: 'b' }] })), /expectedSha256/u);
});

test('closed schema rejects unknown fields and recursively rejects nested authority data', () => {
  assert.throws(() => normalizeControllerPlan(basePlan({ faultInjection: { enabled: true } })), /schema|forbidden controller authority/u);
  assert.throws(() => normalizeControllerPlan(basePlan({ files: [{ path: 'a.txt', content: 'a', mode: '0777' }] })), /not part of the controller-plan schema/u);
  assert.throws(() => normalizeControllerPlan(basePlan({
    operations: [{ id: 'x', operation: 'toolchain.probe', params: { nested: { environment: { SECRET: 'x' } } } }],
  })), /forbidden controller authority/u);
  assert.throws(() => normalizeControllerPlan(basePlan({ assertions: [{ kind: 'workspace-clean', value: true }] })), /not part of the controller-plan schema/u);
});

test('rejects operation authority fields and assertions that name unknown operations', () => {
  assert.throws(() => normalizeControllerPlan(basePlan({ operations: [{ id: 'x', operation: 'node.test', params: { executable: '/bin/sh' } }] })), /forbidden controller authority/u);
  assert.throws(() => normalizeControllerPlan(basePlan({ assertions: [{ kind: 'exit-equals', operation: 'missing', value: 0 }] })), /unknown operation/u);
});

test('repository-code deterministic operations fail closed without a verified sandbox', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'patch-poller-controller-sandbox-'));
  try {
    await writeFile(path.join(root, 'fixture.test.mjs'), "import test from 'node:test'; test('ok', () => {});\n");
    const runner = new DeterministicProcessRunner();
    const registry = createCoreOperationRegistry();
    await assert.rejects(
      registry.execute('node.test', { paths: ['fixture.test.mjs'] }, { projectDir: root, processRunner: runner }),
      /requires a verified sandbox provider/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generic controller executor runs repository tests only through a verified containment request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'patch-poller-controller-plan-'));
  const sandboxRequests = [];
  try {
    const plan = normalizeControllerPlan(basePlan({
      files: [
        { scope: 'persistent', action: 'create', path: 'src/math.mjs', content: 'export function add(a, b) { return a + b; }\n' },
        { scope: 'ephemeral', action: 'create', path: 'test/generated.test.mjs', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n" },
      ],
      operations: [
        { id: 'syntax', operation: 'node.syntax-check', params: { path: 'src/math.mjs' } },
        { id: 'tests', operation: 'node.test', params: { paths: ['test/generated.test.mjs'] } },
      ],
      assertions: [
        { kind: 'exit-equals', operation: 'syntax', value: 0 },
        { kind: 'exit-equals', operation: 'tests', value: 0 },
        { kind: 'file-exists', path: 'test/generated.test.mjs' },
      ],
      expectedChangedPaths: ['src/math.mjs'],
    }));
    const { workspace, workspaceManager } = workspaceFixture(root, ['src/math.mjs']);
    const executor = new ControllerPlanExecutor({
      operationRegistry: createCoreOperationRegistry(),
      processRunner: new DeterministicProcessRunner({ sandboxProvider: verifiedTestSandbox(sandboxRequests) }),
      workspaceManager,
    });
    const state = {};
    let persists = 0;
    const result = await executor.execute({ plan, state, workspace, persist: async () => { persists += 1; } });
    assert.match(await readFile(path.join(root, 'src', 'math.mjs'), 'utf8'), /function add/u);
    await assert.rejects(stat(path.join(root, 'test', 'generated.test.mjs')), { code: 'ENOENT' });
    assert.equal(result.tests.length, 2);
    assert.equal(result.tests.every((entry) => entry.exitCode === 0), true);
    assert.equal(result.tests.find((entry) => entry.operation === 'node.test').sandboxProvider, 'test-verified');
    assert.equal(sandboxRequests.length, 1);
    assert.equal(sandboxRequests[0].required, true);
    assert.equal(sandboxRequests[0].projectWritable, false);
    assert.equal(sandboxRequests[0].network, 'deny');
    assert.equal(state.controllerPlan.finalFileVerification[0].path, 'src/math.mjs');
    assert.equal(state.controllerPlan.cleanup.leftovers.length, 0);
    assert.equal(state.controllerPlan.cleanup.verifiedAbsent, 1);
    assert.ok(persists >= 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('final byte verification rejects an operation that mutates a planned persistent file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'patch-poller-controller-mutate-'));
  try {
    const registry = new DeterministicOperationRegistry().register('fixture.mutate', {
      executionClass: 'repository-code',
      sandboxRequirement: 'verified',
      validate: () => ({}),
      execute: async (_params, { projectDir }) => {
        await writeFile(path.join(projectDir, 'target.txt'), 'hostile\n');
        return { exitCode: 0, timedOut: false, outputTruncated: false, stdout: '', stderr: '' };
      },
    });
    const plan = normalizeControllerPlan(basePlan({
      files: [{ scope: 'persistent', action: 'create', path: 'target.txt', content: 'planned\n' }],
      operations: [{ id: 'mutate', operation: 'fixture.mutate', params: {} }],
      expectedChangedPaths: ['target.txt'],
    }));
    const { workspace, workspaceManager } = workspaceFixture(root, ['target.txt']);
    const executor = new ControllerPlanExecutor({ operationRegistry: registry, processRunner: new DeterministicProcessRunner(), workspaceManager });
    await assert.rejects(executor.execute({ plan, state: {}, workspace, persist: async () => {} }), /final-byte verification failed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('final byte verification rejects recreation of a planned deletion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'patch-poller-controller-delete-'));
  try {
    const original = 'delete me\n';
    await writeFile(path.join(root, 'target.txt'), original);
    const registry = new DeterministicOperationRegistry().register('fixture.recreate', {
      executionClass: 'repository-code', sandboxRequirement: 'verified', validate: () => ({}),
      execute: async (_params, { projectDir }) => {
        await writeFile(path.join(projectDir, 'target.txt'), 'recreated\n');
        return { exitCode: 0, timedOut: false, outputTruncated: false, stdout: '', stderr: '' };
      },
    });
    const plan = normalizeControllerPlan(basePlan({
      files: [{ scope: 'persistent', action: 'delete', path: 'target.txt', expectedSha256: sha256(original) }],
      operations: [{ id: 'recreate', operation: 'fixture.recreate', params: {} }],
      expectedChangedPaths: ['target.txt'],
    }));
    const { workspace, workspaceManager } = workspaceFixture(root, ['target.txt']);
    const executor = new ControllerPlanExecutor({ operationRegistry: registry, processRunner: new DeterministicProcessRunner(), workspaceManager });
    await assert.rejects(executor.execute({ plan, state: {}, workspace, persist: async () => {} }), /deleted path was recreated/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resume reconciles persistent files instead of trusting persisted applied state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'patch-poller-controller-resume-'));
  try {
    await writeFile(path.join(root, 'target.txt'), 'tampered\n');
    const plan = normalizeControllerPlan(basePlan({
      files: [{ scope: 'persistent', action: 'create', path: 'target.txt', content: 'planned\n' }],
      expectedChangedPaths: ['target.txt'],
    }));
    const { workspace, workspaceManager } = workspaceFixture(root, ['target.txt']);
    const executor = new ControllerPlanExecutor({ operationRegistry: new DeterministicOperationRegistry(), processRunner: new DeterministicProcessRunner(), workspaceManager });
    const state = {
      controllerPlan: {
        protocol: plan.protocol, phase: 'materializing',
        files: [{ path: 'target.txt', scope: 'persistent', action: 'create', state: 'applied', digest: plan.files[0].contentSha256 }],
        operations: [], cleanupLedger: [], scratchLedger: [], assertionsPassed: 0,
      },
    };
    await assert.rejects(executor.execute({ plan, state, workspace, persist: async () => {} }), /already exists with different content/u);
    assert.equal(state.controllerPlan.files[0].state, 'reconciling');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
