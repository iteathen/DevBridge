import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { doctor } from '../src/app/doctor.js';
import { ENVIRONMENT_FOUNDATION_STATUS_PROTOCOL } from '../src/runtime/environment-foundation.js';

function configFor(root) {
  return validateConfig({
    version: 1,
    github: { queueRepositories: ['iteathen/DevBridge'], repositoryDiscovery: { enabled: false, affiliations: ['owner'], maxRepositories: 30 }, trustedActorIds: ['1775584'], rateLimit: {} },
    workspace: { root: path.join(root, 'workspace'), allowedOwners: ['iteathen'], allowCreate: true },
    state: { directory: path.join(root, 'state') },
    execution: { enabled: true, controllerPlansEnabled: true, modelAdaptersEnabled: false, faultInjection: { enabled: false, rules: [] } },
    status: {}, tools: {},
  });
}

test('doctor reports environment foundation separately while repository execution remains fail-closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-doctor-stage2-'));
  try {
    const status = {
      protocol: ENVIRONMENT_FOUNDATION_STATUS_PROTOCOL,
      state: 'degraded', ready: false, identity: '0123456789abcdef0123456789abcdef',
      reason: 'no base images are published',
      capabilities: {
        management: { state: 'ready', ready: true, reason: null },
        images: { state: 'unavailable', ready: false, reason: 'no base images are published' },
        networking: { state: 'ready', ready: true, reason: null },
        storage: { state: 'ready', ready: true, reason: null },
      },
    };
    const result = await doctor(configFor(root), {
      checkGit: false,
      checkGitHubAuth: false,
      probeCoreCapabilities: false,
      env: {},
      environmentFoundation: { async inspect() { return status; } },
    });
    assert.deepEqual(result.capabilities.environmentFoundation, status);
    assert.equal(result.capabilities.repositoryExecution.ready, false);
    assert.equal(result.capabilities.repositoryExecution.state, 'unavailable');
    assert.equal(result.capabilities.core.controllerPlans.operations.find((entry) => entry.name === 'node.test').usable, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
