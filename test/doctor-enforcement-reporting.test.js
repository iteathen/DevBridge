import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { doctor } from '../src/app/doctor.js';

function configFor(root, tools = {}) {
  return validateConfig({
    version: 1,
    github: {
      queueRepository: 'owner/queue',
      trustedActorIds: ['1'],
      auth: {
        mode: 'environment',
        environmentVariables: ['GH_TOKEN'],
        githubCliExecutable: 'gh',
        hostname: 'github.com',
      },
    },
    workspace: {
      root: path.join(root, 'workspace'),
      allowCreate: true,
      allowedOwners: ['owner'],
      externalReadRoots: [],
    },
    state: { directory: path.join(root, 'state') },
    execution: {
      enabled: false,
      controllerPlansEnabled: true,
      modelAdaptersEnabled: true,
      allowUncontainedTools: false,
    },
    tools,
  });
}

const declaredOsTool = {
  executable: process.execPath,
  args: ['--version'],
  inputMode: 'none',
  sandbox: {
    enforcement: 'os',
    outsideProjectRead: 'deny',
    outsideProjectWrite: false,
    network: 'deny',
  },
};

test('doctor never upgrades an os declaration into enforcement when provider probing is disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-doctor-declaration-'));
  try {
    const report = await doctor(configFor(root, { claimed: declaredOsTool }), {
      resolveTools: false,
      checkGit: false,
      checkGitHubAuth: false,
      probeCoreCapabilities: false,
    });
    const claimed = report.capabilities.adapters.tools.find((entry) => entry.name === 'claimed');
    assert.ok(claimed);
    assert.equal(claimed.declaredPolicy.toolEnforcement, 'os');
    assert.equal(claimed.enforcement.verified, false);
    assert.equal(claimed.enforcement.usable, false);
    assert.notEqual(claimed.enforcement.verification, 'boundary-probe');

    const builtIns = report.capabilities.adapters.tools.filter((entry) => entry.source === 'patch-poller-builtin');
    assert.ok(builtIns.length >= 1);
    for (const entry of builtIns) {
      assert.equal(entry.declaredPolicy.toolEnforcement, 'none');
      assert.equal(entry.enforcement.verified, false);
    }

    const syntax = report.capabilities.core.controllerPlans.operations.find((entry) => entry.name === 'node.syntax-check');
    const nodeTest = report.capabilities.core.controllerPlans.operations.find((entry) => entry.name === 'node.test');
    assert.equal(syntax.executionClass, 'static-inspection');
    assert.equal(syntax.sandboxRequired, false);
    assert.equal(syntax.usable, true);
    assert.equal(nodeTest.executionClass, 'repository-code');
    assert.equal(nodeTest.sandboxRequired, true);
    assert.equal(nodeTest.enforcementRequirement, 'verified-os-sandbox');
    assert.equal(nodeTest.usable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor exposes actual harmless boundary-probe observations when the platform provider verifies', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-doctor-observed-'));
  try {
    const report = await doctor(configFor(root), {
      resolveTools: false,
      checkGit: false,
      checkGitHubAuth: false,
      probeCoreCapabilities: true,
      env: process.env,
    });
    const provider = report.capabilities.enforcementProvider;
    if (!provider.verified) {
      if (process.env.PATCH_POLLER_REQUIRE_SANDBOX_TEST === '1') {
        assert.fail(`CI requires verified sandbox capability reporting: ${provider.reason}`);
      }
      assert.equal(provider.boundaryProbe?.verified ?? false, false);
      assert.notEqual(provider.verification, 'boundary-probe');
      return;
    }

    assert.equal(provider.provider, 'bubblewrap');
    assert.equal(provider.verification, 'boundary-probe');
    assert.equal(provider.boundaryProbe.attempted, true);
    assert.equal(provider.boundaryProbe.verified, true);
    assert.deepEqual(provider.boundaryProbe.observations, {
      projectWriteAllowed: true,
      runScratchWriteAllowed: true,
      arbitraryOutsideReadDenied: true,
      arbitraryOutsideWriteDenied: true,
      controlStateReadDenied: true,
      gitAdministrativeWriteDenied: true,
      networkEgressDenied: true,
      effectiveCapabilitiesDropped: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
