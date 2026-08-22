import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeControllerPlan } from '../src/run/controller-plan.js';
import { ControllerPlanExecutor } from '../src/run/controller-plan-executor.js';
import { ControllerInputRegistry } from '../src/run/controller-input-registry.js';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { deterministicOperationSecurity } from '../src/runtime/deterministic-operation-security.js';

const destination = 'test/fixtures/input.bundle';

test('locally registered input materializes through host control into an ephemeral reserved path and is cleaned', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-input-plan-'));
  try {
    const inputRegistry = new ControllerInputRegistry();
    inputRegistry.register('fixture.one', {
      destination,
      async load() { return { bytes: Buffer.from('fixture-bytes'), subject: 'subject-one' }; },
    });
    const operationRegistry = createCoreOperationRegistry({ inputRegistry });
    const plan = normalizeControllerPlan({
      protocol: 'devbridge/controller-plan-v1',
      files: [{ scope: 'ephemeral', action: 'reserve', path: destination }],
      operations: [{ id: 'materialize', operation: 'input.materialize', params: { source: 'fixture.one' } }],
      assertions: [
        { kind: 'file-exists', path: destination },
        { kind: 'json-field-equals', operation: 'materialize', stream: 'stdout', field: 'subject', value: 'subject-one' },
      ],
    });
    const workspace = { worktreeDir: root, branch: 'fixture', baseSha: '1'.repeat(40), runId: 'input-plan' };
    const snapshot = { branch: 'fixture', baseSha: workspace.baseSha, headSha: workspace.baseSha, dirty: false, changedFiles: [], unmergedFiles: [], status: '' };
    const workspaceManager = { snapshot: async () => snapshot, validate: async () => snapshot };
    const executor = new ControllerPlanExecutor({ operationRegistry, processRunner: {}, workspaceManager });
    const state = {};
    const result = await executor.execute({ plan, state, workspace, persist: async () => {} });

    assert.equal(result.tests.length, 1);
    assert.equal(result.tests[0].exitCode, 0);
    assert.equal(state.controllerPlan.cleanup.verifiedAbsent, 1);
    await assert.rejects(stat(path.join(root, ...destination.split('/'))), { code: 'ENOENT' });
    assert.equal(deterministicOperationSecurity('input.materialize').repositoryCode, false);
    assert.equal(deterministicOperationSecurity('input.materialize').executionRequirement, 'host-control');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('input.materialize cannot select an unregistered source', () => {
  const operationRegistry = createCoreOperationRegistry({ inputRegistry: new ControllerInputRegistry() });
  assert.throws(() => operationRegistry.validate('input.materialize', { source: 'fixture.missing' }), /not locally registered/u);
  assert.throws(() => operationRegistry.validate('input.materialize', { source: 'fixture.one', path: 'elsewhere' }), /parameter path is not allowed/u);
});
