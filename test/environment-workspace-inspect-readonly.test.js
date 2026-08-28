import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentConstructionWorkspaces } from '../src/app/environment-construction-workspaces.js';
import { executionProfileSubject, executionWorkspaceIdentity } from '../src/app/execution-profile-routing.js';

function stateFor(profile) {
  const physical = {
    record: { identity: 'env-0123456789abcdef0123456789abcdef', subject: executionProfileSubject(profile), profile },
    observation: { exists: true, owned: true, compatible: true },
  };
  return {
    inspect: async () => ({ ready: true }),
    listEnvironments: async () => [structuredClone(physical)],
    observeEnvironment: async () => structuredClone(physical),
  };
}

test('workspace inspection performs health checks only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-workspace-inspect-'));
  try {
    const profile = 'linux-development';
    const subject = '42';
    const workspace = { identity: executionWorkspaceIdentity(subject, profile), authority: 'authority-a' };
    const declaration = { profile, workspaces: [workspace] };
    const events = [];
    const channel = {
      async health(target) { events.push(['health', target]); return { ready: true }; },
      async put() { events.push(['put']); throw new Error('inspect must not write'); },
      async get() { throw new Error('inspect must not read workspace content'); },
      async execute() { events.push(['execute']); throw new Error('inspect must not execute guest code'); },
    };
    const port = createEnvironmentConstructionWorkspaces({
      stateDirectory: directory,
      state: stateFor(profile),
      channel,
      resolveAuthority: async () => subject,
    });
    const result = await port.inspect({ declaration, workspaces: declaration.workspaces, implementationGeneration: 'env-0123456789abcdef0123456789abcdef' });
    assert.equal(result.ready, true);
    assert.deepEqual(events.map((entry) => entry[0]), ['health']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
