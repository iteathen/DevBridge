import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.js';
import { doctor } from '../src/app/doctor.js';

function configFor(root) {
  return validateConfig({
    version: 1,
    github: { queueRepositories: ['iteathen/DevBridge'], trustedActorIds: ['1775584'], rateLimit: {} },
    workspace: { root: path.join(root, 'workspace'), allowedOwners: ['iteathen'], allowCreate: true },
    state: { directory: path.join(root, 'state') },
    execution: { enabled: true, controllerPlansEnabled: true, modelAdaptersEnabled: false, faultInjection: { enabled: false, rules: [] } },
    status: {}, tools: {},
  });
}

test('doctor consumes only the read-only environment operator inspection contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-doctor-lifecycle-'));
  try {
    let inspected = 0;
    const environmentOperator = {
      async inspect() {
        inspected += 1;
        return { protocol: 'devbridge/environment-operator-v1', state: 'recovery-required', nextAction: 'resume', declarationCount: 1, activeTransitionCount: 1, setupReentryRequired: false, environments: [] };
      },
      async run() { throw new Error('doctor must not mutate lifecycle state'); },
    };
    const result = await doctor(configFor(root), {
      resolveTools: false,
      checkGit: false,
      checkGitHubAuth: false,
      probeCoreCapabilities: false,
      env: {},
      environmentOperator,
    });
    assert.equal(inspected, 1);
    assert.equal(result.capabilities.environmentLifecycle.nextAction, 'resume');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
