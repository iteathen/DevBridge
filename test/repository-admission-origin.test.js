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
import { RepositoryAdmissionError } from '../src/errors.js';

const exec = promisify(execFile);

test('managed origin mismatch keeps remote details local and exposes only typed repair guidance', async () => {
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
      assert.ok(error instanceof RepositoryAdmissionError);
      assert.equal(error.phase, 'origin');
      assert.equal(error.kind, 'origin-mismatch');
      assert.match(error.message, /repository admission failed during origin: origin-mismatch/u);
      assert.match(error.repair, /review the managed repository origin/u);
      assert.doesNotMatch(error.message, /github\.com\/wrong\/repo/u);
      assert.doesNotMatch(error.message, /github\.com\/owner\/repo/u);
      assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
      assert.doesNotMatch(error.message, /x-access-token/u);
      assert.doesNotMatch(error.message, new RegExp(root.replaceAll('\\', '\\\\').replaceAll('/', '\\/'), 'u'));
      assert.match(error.stderr, /expected remote:/u);
      assert.match(error.stderr, /observed remote:/u);
      assert.doesNotMatch(error.stderr, new RegExp(secret, 'u'));
      return true;
    },
  );
});
