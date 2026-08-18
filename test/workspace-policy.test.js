import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspacePolicy } from '../src/security/workspace-policy.js';
import { PolicyError } from '../src/errors.js';

test('maps allowed repository identity under managed root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-workspace-'));
  const policy = new WorkspacePolicy({ root, allowedOwners: ['iteathen'] });
  const candidate = policy.projectPath('iteathen/PATCH-POLLER');
  assert.equal(candidate, path.join(root, 'repositories', 'iteathen', 'PATCH-POLLER'));
  assert.equal(await policy.assertWriteContained(candidate), path.resolve(candidate));
});

test('rejects disallowed owners and traversal-shaped repository names', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-workspace-'));
  const policy = new WorkspacePolicy({ root, allowedOwners: ['iteathen'] });
  assert.throws(() => policy.projectPath('attacker/repo'), PolicyError);
  assert.throws(() => policy.projectPath('../repo'), PolicyError);
});

test('rejects writes through a symlink that escapes the workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-workspace-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'pp-outside-'));
  const policy = new WorkspacePolicy({ root, allowedOwners: ['iteathen'] });
  await policy.ensureRoot();
  const repos = path.join(root, 'repositories');
  await mkdir(repos, { recursive: true });
  const link = path.join(repos, 'iteathen');
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`symlink unavailable: ${error.message}`);
    return;
  }
  await assert.rejects(() => policy.assertWriteContained(path.join(link, 'repo')), PolicyError);
});
