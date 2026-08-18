import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { doctor } from '../src/app/doctor.js';

test('doctor distinguishes controller core capabilities from optional external adapters', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-doctor-capabilities-'));
  const config = validateConfig({
    version: 1,
    github: { queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'], rateLimit: {} },
    workspace: { root: path.join(root, 'workspace'), allowedOwners: ['iteathen'], allowCreate: true },
    state: { directory: path.join(root, 'state') },
    execution: {
      enabled: true,
      controllerPlansEnabled: true,
      modelAdaptersEnabled: false,
      faultInjection: { enabled: false, rules: [] },
    },
    status: {},
    tools: {},
  });
  const result = await doctor(config, {
    resolveTools: false,
    checkGit: false,
    checkGitHubAuth: false,
    probeCoreCapabilities: false,
    env: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.capabilities.core.controllerPlans.enabled, true);
  const operations = result.capabilities.core.controllerPlans.operations.map((entry) => entry.name);
  assert.ok(operations.includes('node.test'));
  assert.ok(operations.includes('cmake.configure'));
  assert.equal(operations.includes('node.run'), false);
  assert.deepEqual(result.capabilities.core.toolchains.map((entry) => entry.name), ['cmake', 'ctest', 'native.c', 'native.linker', 'node']);
  assert.equal(result.capabilities.adapters.enabled, false);
  assert.deepEqual(result.capabilities.adapters.tools, []);
});

test('doctor rejects an enabled executor only when both controller plans and adapters are absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-doctor-disabled-'));
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
});
