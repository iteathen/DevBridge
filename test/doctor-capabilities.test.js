import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { doctor } from '../src/app/doctor.js';

test('doctor distinguishes static operations from sandbox-required repository execution and reports verification honestly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-doctor-capabilities-'));
  const config = validateConfig({
    version: 1,
    github: { queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'], rateLimit: {} },
    workspace: { root: path.join(root, 'workspace'), allowedOwners: ['iteathen'], allowCreate: true },
    state: { directory: path.join(root, 'state') },
    execution: { enabled: true, controllerPlansEnabled: true, modelAdaptersEnabled: false, faultInjection: { enabled: false, rules: [] } },
    status: {},
    tools: {},
  });
  const result = await doctor(config, { resolveTools: false, checkGit: false, checkGitHubAuth: false, probeCoreCapabilities: false, sandboxProvider: null, env: {} });
  assert.equal(result.ok, true);
  const byName = Object.fromEntries(result.capabilities.core.controllerPlans.operations.map((entry) => [entry.name, entry]));
  assert.equal(byName['node.syntax-check'].executionClass, 'static-inspection');
  assert.equal(byName['node.syntax-check'].usable, true);
  assert.equal(byName['node.test'].executionClass, 'repository-code-executing');
  assert.equal(byName['node.test'].requiredEnforcement, 'verified-sandbox');
  assert.equal(byName['node.test'].usable, false);
  assert.equal(byName['cmake.configure'].usable, false);
  assert.equal(Object.hasOwn(byName, 'node.run'), false);
  assert.equal(result.enforcement.provider.provider, 'none');
  assert.equal(result.enforcement.provider.verified, false);
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
  await assert.rejects(() => doctor(config, { checkGit: false, checkGitHubAuth: false, probeCoreCapabilities: false, sandboxProvider: null, env: {} }), /neither controller plans nor valid local tool profiles/u);
});
