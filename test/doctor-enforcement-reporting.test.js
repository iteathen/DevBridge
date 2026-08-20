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
    github: { queueRepositories: ['owner/queue'], repositoryDiscovery: { enabled: false, affiliations: ['owner'], maxRepositories: 30 }, trustedActorIds: ['1'] },
    workspace: { root: path.join(root, 'workspace'), allowCreate: true, allowedOwners: ['owner'], externalReadRoots: [] },
    state: { directory: path.join(root, 'state') },
    execution: { enabled: false, controllerPlansEnabled: true, modelAdaptersEnabled: false, allowUncontainedTools: false },
    tools: {},
  });
}

test('doctor no-provider reporting is provider-neutral and contains no legacy enforcement claim', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-doctor-report-'));
  try {
    const report = await doctor(configFor(root), { resolveTools: false, checkGit: false, checkGitHubAuth: false, probeCoreCapabilities: false, env: {} });
    const execution = report.capabilities.repositoryExecution;
    assert.deepEqual(Object.keys(execution).sort(), ['identity', 'protocol', 'ready', 'reason', 'state']);
    assert.equal(execution.state, 'unavailable');
    assert.equal(execution.ready, false);
    assert.match(execution.reason, /execution routes/u);
    const text = JSON.stringify(report.capabilities);
    assert.doesNotMatch(text, /bubblewrap|processcontainer|appcontainer/iu);
    assert.doesNotMatch(text, /sandboxRequired|verified-os-sandbox/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
