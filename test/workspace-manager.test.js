import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspacePolicy } from '../src/security/workspace-policy.js';
import { GitClient } from '../src/git/git-client.js';
import { GitWorkspaceManager } from '../src/git/workspace-manager.js';
const exec = promisify(execFile);
async function git(cwd, args) { return exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }

test('provisions and resumes an isolated managed worktree from a local fixture repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-workspace-manager-'));
  const source = path.join(root, 'source');
  await exec('git', ['init', '-b', 'main', source]);
  await writeFile(path.join(source, 'README.md'), 'one\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['-c', 'user.name=Patch Poller Test', '-c', 'user.email=patch-poller@example.invalid', 'commit', '-m', 'initial']);
  const policy = new WorkspacePolicy({ root: path.join(root, 'managed'), allowedOwners: ['owner'], allowCreate: true });
  await policy.ensureRoot();
  const client = new GitClient({ syntheticHome: path.join(root, 'git-home'), allowFileProtocol: true });
  const manager = new GitWorkspaceManager({ workspacePolicy: policy, gitClient: client, remoteUrlResolver: () => source });
  const task = { issueNumber: 17, revision: 'a'.repeat(64), envelope: { target: { repository: 'owner/repo' } } };
  const workspace = await manager.prepareRun(task, 'run-17');
  assert.equal(await readFile(path.join(workspace.worktreeDir, 'README.md'), 'utf8'), 'one\n');
  assert.match(workspace.branch, /^patchpoller\/issue-17-/);
  await writeFile(path.join(workspace.worktreeDir, 'README.md'), 'two\n');
  const snapshot = await manager.snapshot(workspace);
  assert.equal(snapshot.dirty, true);
  assert.deepEqual(snapshot.changedFiles, ['README.md']);
  const resumed = await manager.prepareRun(task, 'run-17');
  assert.equal(resumed.worktreeDir, workspace.worktreeDir);
  assert.equal(resumed.branch, workspace.branch);
});
