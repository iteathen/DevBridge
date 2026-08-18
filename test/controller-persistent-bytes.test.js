import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControllerPlanExecutor } from '../src/run/controller-plan-executor.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function planFor(content) {
  return {
    protocol: 'patch-poller/controller-plan-v1',
    files: [{
      path: 'planned.txt',
      scope: 'project',
      action: 'create',
      content,
      contentSha256: sha256(content),
      expectedSha256: null,
    }],
    operations: [{ id: 'probe', operation: 'fixture.probe', params: {} }],
    assertions: [],
    expectedChangedPaths: ['planned.txt'],
  };
}

function operationRegistry(execute) {
  return {
    validate(name) { assert.equal(name, 'fixture.probe'); },
    execute,
  };
}

function workspaceManager(changedFiles = ['planned.txt']) {
  return {
    async validate(workspace) {
      return {
        branch: 'task/fixture',
        baseSha: workspace.baseSha,
        headSha: workspace.baseSha,
        dirty: true,
        changedFiles,
      };
    },
  };
}

function successResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    stdout: '',
    stderr: '',
    sandbox: { provider: 'fixture', verified: true },
  };
}

test('controller plan rejects a planned persistent file tampered by a later executable operation', async () => {
  const worktreeDir = await mkdtemp(path.join(os.tmpdir(), 'pp-controller-byte-tamper-'));
  const workspace = { worktreeDir, baseSha: 'a'.repeat(40), repository: 'iteathen/PATCH-POLLER', runId: 'fixture' };
  const executor = new ControllerPlanExecutor({
    operationRegistry: operationRegistry(async (_name, _params, context) => {
      await writeFile(path.join(context.projectDir, 'planned.txt'), 'tampered');
      return successResult();
    }),
    processRunner: {},
    workspaceManager: workspaceManager(),
  });
  const state = {};

  await assert.rejects(
    executor.execute({ plan: planFor('intended'), state, workspace, persist: async () => {} }),
    /persistent-byte verification failed: planned\.txt changed after materialization/u,
  );
  assert.equal(state.controllerPlan.phase, 'verifying-persistent-bytes');
});

test('controller plan records verified digest when executable operations leave planned bytes intact', async () => {
  const worktreeDir = await mkdtemp(path.join(os.tmpdir(), 'pp-controller-byte-good-'));
  const workspace = { worktreeDir, baseSha: 'a'.repeat(40), repository: 'iteathen/PATCH-POLLER', runId: 'fixture' };
  const executor = new ControllerPlanExecutor({
    operationRegistry: operationRegistry(async () => successResult()),
    processRunner: {},
    workspaceManager: workspaceManager(),
  });
  const state = {};
  const result = await executor.execute({ plan: planFor('intended'), state, workspace, persist: async () => {} });

  assert.equal(state.controllerPlan.phase, 'complete');
  assert.equal(state.controllerPlan.files[0].verifiedDigest, sha256('intended'));
  assert.match(state.controllerPlan.files[0].verifiedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(result.snapshot.changedFiles, ['planned.txt']);
});
