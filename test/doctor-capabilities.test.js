import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { doctor } from '../src/app/doctor.js';

function configFor(root, execution = {}) {
  return validateConfig({
    version: 1,
    github: { queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'], rateLimit: {} },
    workspace: { root: path.join(root, 'workspace'), allowedOwners: ['iteathen'], allowCreate: true },
    state: { directory: path.join(root, 'state') },
    execution: {
      enabled: true,
      controllerPlansEnabled: true,
      modelAdaptersEnabled: false,
      faultInjection: { enabled: false, rules: [] },
      ...execution,
    },
    status: {},
    tools: {},
  });
}

test('doctor distinguishes static controller operations from repository-code operations requiring verified sandboxing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-doctor-capabilities-'));
  try {
    const result = await doctor(configFor(root), {
      resolveTools: false,
      checkGit: false,
      checkGitHubAuth: false,
      probeCoreCapabilities: false,
      env: {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.capabilities.core.controllerPlans.enabled, true);
    const controller = result.capabilities.core.controllerPlans;
    assert.equal(controller.sandbox.verified, false);
    const byName = new Map(controller.operations.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('node.syntax-check').executionClass, 'static-inspection');
    assert.equal(byName.get('node.syntax-check').sandboxRequired, false);
    assert.equal(byName.get('node.syntax-check').usable, true);
    assert.equal(byName.get('toolchain.probe').executionClass, 'control-process');
    assert.equal(byName.get('toolchain.probe').sandboxRequired, false);
    assert.equal(byName.get('toolchain.probe').usable, true);
    assert.equal(byName.get('node.test').executionClass, 'repository-code');
    assert.equal(byName.get('node.test').sandboxRequired, true);
    assert.equal(byName.get('node.test').usable, false);
    assert.equal(byName.get('cmake.configure').sandboxRequired, true);
    assert.equal(byName.has('node.run'), false);
    assert.deepEqual(result.capabilities.core.toolchains.map((entry) => entry.name), ['cmake', 'ctest', 'native.c', 'native.linker', 'node']);
    assert.equal(result.capabilities.adapters.enabled, false);
    assert.deepEqual(result.capabilities.adapters.tools, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor reports observed sandbox verification and gates repository-code usability on it', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-doctor-sandbox-observed-'));
  try {
    const result = await doctor(configFor(root), {
      resolveTools: false,
      checkGit: false,
      checkGitHubAuth: false,
      probeCoreCapabilities: true,
      env: process.env,
    });
    const controller = result.capabilities.core.controllerPlans;
    assert.equal(typeof controller.sandbox.provider, 'string');
    assert.equal(typeof controller.sandbox.verification, 'string');
    assert.equal(typeof controller.sandbox.verified, 'boolean');
    const nodeTest = controller.operations.find((entry) => entry.name === 'node.test');
    assert.equal(nodeTest.usable, controller.sandbox.verified);
    if (controller.sandbox.verified) {
      assert.equal(controller.sandbox.provider, 'bubblewrap');
      assert.equal(controller.sandbox.network, 'denied');
      assert.equal(controller.sandbox.filesystem, 'project-and-run-scratch-write-only');
    } else {
      assert.equal(nodeTest.usable, false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor rejects an enabled executor only when both controller plans and adapters are absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-doctor-disabled-'));
  try {
    const config = validateConfig({
      version: 1,
      github: { queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'], rateLimit: {} },
      workspace: { root: path.join(root, 'workspace'), allowedOwners: ['iteathen'], allowCreate: true },
      state: { directory: path.join(root, 'state') },
      execution: { enabled: true, controllerPlansEnabled: false, modelAdaptersEnabled: false },
      status: {},
      tools: {},
    });
    await assert.rejects(() => doctor(config, {
      checkGit: false,
      checkGitHubAuth: false,
      probeCoreCapabilities: false,
      env: {},
    }), /neither controller plans nor valid local tool profiles/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
