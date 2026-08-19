import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeControllerPlan } from '../src/run/controller-plan.js';
import { ControllerPlanExecutor } from '../src/run/controller-plan-executor.js';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function operationRegistry(effect) {
  return {
    validate: () => {},
    execute: async (_name, _params, context) => {
      await effect(context.projectDir);
      return {
        exitCode: 0,
        timedOut: false,
        outputTruncated: false,
        stdout: '',
        stderr: '',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        lastOutputAt: null,
      };
    },
  };
}

function workspaceManager(changedFiles, { onSeal = null } = {}) {
  const snapshot = {
    branch: 'fixture',
    baseSha: '1'.repeat(40),
    headSha: '1'.repeat(40),
    dirty: true,
    changedFiles,
    unmergedFiles: [],
    status: changedFiles.map((entry) => ` M ${entry}`).join('\n'),
  };
  return {
    snapshot: async () => structuredClone(snapshot),
    validate: async () => structuredClone(snapshot),
    sealCandidate: async () => {
      onSeal?.();
      return structuredClone(snapshot);
    },
  };
}

function planWithOperation(files) {
  return normalizeControllerPlan({
    protocol: 'devbridge/controller-plan-v1',
    files,
    operations: [{ id: 'hostile', operation: 'fixture.mutate', params: {} }],
    assertions: [],
  });
}

async function execute(plan, root, registry, state = {}) {
  const executor = new ControllerPlanExecutor({
    operationRegistry: registry,
    processRunner: null,
    workspaceManager: workspaceManager(plan.expectedChangedPaths),
  });
  const workspace = { worktreeDir: root, branch: 'fixture', baseSha: '1'.repeat(40) };
  await executor.execute({ plan, state, workspace, persist: async () => {} });
}

test('operation mutation of a planned persistent create is rejected even when changed paths still match', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-final-byte-mutate-'));
  try {
    const authorized = 'authorized bytes\n';
    const plan = planWithOperation([
      { scope: 'persistent', action: 'create', path: 'src/planned.txt', content: authorized },
    ]);
    const state = {};
    const registry = operationRegistry(async (projectDir) => {
      await writeFile(path.join(projectDir, 'src', 'planned.txt'), 'hostile mutation\n');
    });
    await assert.rejects(
      () => execute(plan, root, registry, state),
      /persistent create target SHA-256 differs from the plan/u,
    );
    assert.equal(await readFile(path.join(root, 'src', 'planned.txt'), 'utf8'), 'hostile mutation\n');
    assert.equal(state.controllerPlan.persistentVerification.verified, 0);
    assert.equal(state.controllerPlan.persistentVerification.files[0].state, 'mismatch');
    assert.equal(state.controllerPlan.persistentVerification.files[0].expectedSha256, sha256(authorized));
    assert.equal(state.controllerPlan.persistentVerification.files[0].observedSha256, sha256('hostile mutation\n'));
    assert.notEqual(state.controllerPlan.phase, 'complete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operation recreation of a planned persistent deletion is rejected before completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-final-byte-delete-'));
  try {
    const original = 'delete me\n';
    await writeFile(path.join(root, 'delete-me.txt'), original);
    const plan = planWithOperation([
      { scope: 'persistent', action: 'delete', path: 'delete-me.txt', expectedSha256: sha256(original) },
    ]);
    const state = {};
    const registry = operationRegistry(async (projectDir) => {
      await writeFile(path.join(projectDir, 'delete-me.txt'), 'recreated by test\n');
    });
    await assert.rejects(
      () => execute(plan, root, registry, state),
      /persistent delete target was recreated/u,
    );
    assert.equal(state.controllerPlan.persistentVerification.files[0].state, 'mismatch');
    assert.equal(state.controllerPlan.persistentVerification.files[0].observedSha256, sha256('recreated by test\n'));
    assert.notEqual(state.controllerPlan.phase, 'complete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resume rechecks final bytes instead of trusting a persisted applied record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-final-byte-resume-'));
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    const authorized = 'authorized\n';
    const malicious = 'changed after crash\n';
    await writeFile(path.join(root, 'src', 'resume.txt'), malicious);
    const plan = normalizeControllerPlan({
      protocol: 'devbridge/controller-plan-v1',
      files: [{ scope: 'persistent', action: 'create', path: 'src/resume.txt', content: authorized }],
      operations: [],
      assertions: [],
    });
    const state = {
      controllerPlan: {
        protocol: plan.protocol,
        phase: 'running-operations',
        files: [{
          path: 'src/resume.txt',
          scope: 'persistent',
          action: 'create',
          state: 'applied',
          digest: sha256(authorized),
        }],
        operations: [],
        cleanupLedger: [],
        scratchLedger: [],
        assertionsPassed: 0,
        startedAt: new Date().toISOString(),
        persistentVerification: {
          required: 1,
          verified: 1,
          files: [{ path: 'src/resume.txt', state: 'verified-exact' }],
          completedAt: new Date().toISOString(),
        },
      },
    };
    const executor = new ControllerPlanExecutor({
      operationRegistry: operationRegistry(async () => {}),
      processRunner: null,
      workspaceManager: workspaceManager(['src/resume.txt']),
    });
    const workspace = { worktreeDir: root, branch: 'fixture', baseSha: '1'.repeat(40) };
    await assert.rejects(
      () => executor.execute({ plan, state, workspace, persist: async () => {} }),
      /persistent create target SHA-256 differs from the plan/u,
    );
    assert.equal(state.controllerPlan.persistentVerification.verified, 0);
    assert.equal(state.controllerPlan.persistentVerification.files.length, 1);
    assert.equal(state.controllerPlan.persistentVerification.files[0].state, 'mismatch');
    assert.equal(state.controllerPlan.persistentVerification.files[0].observedSha256, sha256(malicious));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('untampered persistent proposals are reverified before changed-path validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-final-byte-ok-'));
  try {
    const plan = normalizeControllerPlan({
      protocol: 'devbridge/controller-plan-v1',
      files: [{ scope: 'persistent', action: 'create', path: 'ok.txt', content: 'ok\n' }],
      operations: [],
      assertions: [],
    });
    const state = {};
    const executor = new ControllerPlanExecutor({
      operationRegistry: operationRegistry(async () => {}),
      processRunner: null,
      workspaceManager: workspaceManager(['ok.txt']),
    });
    const result = await executor.execute({
      plan,
      state,
      workspace: { worktreeDir: root, branch: 'fixture', baseSha: '1'.repeat(40) },
      persist: async () => {},
    });
    assert.equal(state.controllerPlan.persistentVerification.required, 1);
    assert.equal(state.controllerPlan.persistentVerification.verified, 1);
    assert.equal(state.controllerPlan.persistentVerification.files[0].state, 'verified-exact');
    assert.match(result.summary, /reverified 1\/1 persistent file proposals/u);
    assert.equal(state.controllerPlan.phase, 'complete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
