import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { doctor } from '../src/app/doctor.js';

test('doctor distinguishes static core capabilities from repository-code operations and reports unverified sandbox honestly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-doctor-capabilities-'));
  try {
    const config = validateConfig({
      version: 1,
      github: { queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'], rateLimit: {} },
      workspace: { root: path.join(root, 'workspace'), allowedOwners: ['iteathen'], allowCreate: true },
      state: { directory: path.join(root, 'state') },
      execution: {
        enabled: true,
        controllerPlansEnabled: true,
        modelAdaptersEnabled: false,
        sandbox: { provider: 'auto', verifyOnStartup: true },
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
      probeSandbox: true,
      env: {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.sandbox.verified, false);
    assert.notEqual(result.sandbox.verification, 'enforced-by-declaration');
    assert.equal(result.capabilities.core.controllerPlans.enabled, true);
    const operations = new Map(result.capabilities.core.controllerPlans.operations.map((entry) => [entry.name, entry]));
    assert.equal(operations.get('node.syntax-check').executionClass, 'static-inspection');
    assert.equal(operations.get('node.syntax-check').usable, true);
    assert.equal(operations.get('node.test').executionClass, 'repository-code');
    assert.equal(operations.get('node.test').sandboxRequirement, 'verified');
    assert.equal(operations.get('node.test').usable, false);
    assert.equal(operations.get('cmake.configure').usable, false);
    assert.equal(operations.has('node.run'), false);
    assert.deepEqual(result.capabilities.core.toolchains.map((entry) => entry.name), ['cmake', 'ctest', 'native.c', 'native.linker', 'node']);
    assert.equal(result.capabilities.adapters.enabled, false);
    assert.deepEqual(result.capabilities.adapters.tools, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor cannot gain verified enforcement from a profile declaration alone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-doctor-declaration-'));
  try {
    const config = validateConfig({
      version: 1,
      github: { queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'], rateLimit: {} },
      workspace: { root: path.join(root, 'workspace'), allowedOwners: ['iteathen'], allowCreate: true },
      state: { directory: path.join(root, 'state') },
      execution: { enabled: false, sandbox: { provider: 'none' } },
      status: {},
      tools: {
        declaredOs: {
          executable: process.execPath,
          args: [],
          sandbox: { enforcement: 'os', requiresVerifiedSandbox: true, outsideProjectWrite: false, network: 'deny' },
        },
      },
    });
    const result = await doctor(config, { resolveTools: false, checkGit: false, checkGitHubAuth: false, probeCoreCapabilities: false, env: {} });
    assert.equal(result.tools[0].declaredPolicy.declaredEnforcement, 'os');
    assert.equal(result.tools[0].enforcement.verified, false);
    assert.equal(result.tools[0].usable, false);
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
