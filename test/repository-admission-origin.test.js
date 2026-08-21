import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitClient } from '../src/git/git-client.js';
import { GitWorkspaceManager } from '../src/git/workspace-manager.js';
import { WorkspacePolicy } from '../src/security/workspace-policy.js';
import { PolicyError } from '../src/errors.js';

const exec = promisify(execFile);

test('managed origin mismatch stays explicit while credential-bearing actual origin is sanitized', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-admission-origin-mismatch-'));
  const workspacePolicy = new WorkspacePolicy({
    root: path.join(root, 'managed'),
    allowedOwners: ['owner'],
    allowCreate: true,
  });
  await workspacePolicy.ensureRoot();
  const repoDir = workspacePolicy.projectPath('owner/repo');
  await mkdir(path.dirname(repoDir), { recursive: true });
  await exec('git', ['init', '-b', 'main', repoDir]);
  const secret = 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  await exec('git', ['-C', repoDir, 'remote', 'add', 'origin', `https://x-access-token:${secret}@github.com/wrong/repo.git`]);

  const manager = new GitWorkspaceManager({
    workspacePolicy,
    gitClient: new GitClient({ syntheticHome: path.join(root, 'git-home') }),
    remoteUrlResolver: () => 'https://github.com/owner/repo.git',
  });

  await assert.rejects(
    manager.ensureRepository('owner/repo'),
    (error) => {
      assert.ok(error instanceof PolicyError);
      assert.match(error.message, /managed repository origin mismatch/u);
      assert.match(error.message, /https:\/\/github\.com\/wrong\/repo\.git/u);
      assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
      assert.doesNotMatch(error.message, /x-access-token/u);
      return true;
    },
  );
});
