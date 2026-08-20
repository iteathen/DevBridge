import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { doctor } from '../src/app/doctor.js';
import { REPOSITORY_EXECUTION_STATUS_PROTOCOL } from '../src/runtime/repository-execution.js';

function configFor(root, execution = {}) {
  return validateConfig({
    version: 1,
    github: { queueRepository: 'iteathen/DevBridge', trustedActorIds: ['1775584'], rateLimit: {} },
    workspace: { root: path.join(root, 'workspace'), allowedOwners: ['iteathen'], allowCreate: true },
    state: { directory: path.join(root, 'state') },
    execution: { enabled: true, controllerPlansEnabled: true, modelAdaptersEnabled: false, faultInjection: { enabled: false, rules: [] }, ...execution },
    status: {}, tools: {},
  });
}

test('doctor reports intentional no-provider state while keeping host-static operations usable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-doctor-stage1-'));
  try {
    const result = await doctor(configFor(root), { resolveTools: false, checkGit: false, checkGitHubAuth: false, probeCoreCapabilities: false, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.capabilities.repositoryExecution.state, 'unavailable');
    assert.equal(result.capabilities.repositoryExecution.ready, false);
    const byName = new Map(result.capabilities.core.controllerPlans.operations.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('node.syntax-check').executionClass, 'static-inspection');
    assert.equal(byName.get('node.syntax-check').repositoryExecutionRequired, false);
    assert.equal(byName.get('node.syntax-check').usable, true);
    assert.equal(byName.get('toolchain.probe').executionClass, 'control-process');
    assert.equal(byName.get('toolchain.probe').usable, true);
    assert.equal(byName.get('node.test').repositoryExecutionRequired, true);
    assert.equal(byName.get('node.test').usable, false);
    assert.equal(byName.get('cmake.configure').usable, false);
    assert.equal(JSON.stringify(result).includes('bubblewrap'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('doctor accepts a provider-neutral fake through the same capability stud', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-doctor-fake-'));
  try {
    const fake = {
      inspect: () => ({ protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'ready', ready: true, identity: 'fake-execution', reason: null }),
      async execute() { throw new Error('doctor must not execute repository code'); },
    };
    const result = await doctor(configFor(root), { resolveTools: false, checkGit: false, checkGitHubAuth: false, probeCoreCapabilities: false, env: {}, repositoryExecution: fake });
    assert.equal(result.capabilities.repositoryExecution.ready, true);
    assert.equal(result.capabilities.repositoryExecution.identity, 'fake-execution');
    const nodeTest = result.capabilities.core.controllerPlans.operations.find((entry) => entry.name === 'node.test');
    assert.equal(nodeTest.usable, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('doctor rejects an enabled executor only when both controller plans and adapters are absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-doctor-disabled-'));
  try {
    const config = validateConfig({
      version: 1,
      github: { queueRepository: 'iteathen/DevBridge', trustedActorIds: ['1775584'], rateLimit: {} },
      workspace: { root: path.join(root, 'workspace'), allowedOwners: ['iteathen'], allowCreate: true },
      state: { directory: path.join(root, 'state') },
      execution: { enabled: true, controllerPlansEnabled: false, modelAdaptersEnabled: false },
      status: {}, tools: {},
    });
    await assert.rejects(() => doctor(config, { checkGit: false, checkGitHubAuth: false, probeCoreCapabilities: false, env: {} }), /neither controller plans nor valid local tool profiles/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
