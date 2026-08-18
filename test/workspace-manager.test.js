import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspacePolicy } from '../src/security/workspace-policy.js';
import { GitClient } from '../src/git/git-client.js';
import { GitWorkspaceManager } from '../src/git/workspace-manager.js';
import { PolicyError } from '../src/errors.js';
const exec = promisify(execFile);
async function git(cwd, args) { return exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }
async function fixture() {
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
  return { root, source, client, manager, task };
}

test('provisions, seals, and resumes an isolated managed worktree while ignoring runtime exchange files', async () => {
  const { manager, task } = await fixture();
  const workspace = await manager.prepareRun(task, 'run-17');
  assert.equal(await readFile(path.join(workspace.worktreeDir, 'README.md'), 'utf8'), 'one\n');
  assert.match(workspace.branch, /^patchpoller\/issue-17-/);
  await writeFile(path.join(workspace.worktreeDir, 'README.md'), 'two\n');
  await mkdir(path.join(workspace.worktreeDir, '.patch-poller'), { recursive: true });
  await writeFile(path.join(workspace.worktreeDir, '.patch-poller', 'context.json'), '{}\n');
  const snapshot = await manager.snapshot(workspace);
  assert.equal(snapshot.dirty, true);
  assert.deepEqual(snapshot.changedFiles, ['README.md']);
  const sealed = await manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
  assert.equal(sealed.dirty, false);
  assert.notEqual(sealed.headSha, sealed.baseSha);
  assert.deepEqual(sealed.changedFiles, ['README.md']);
  const resumed = await manager.prepareRun(task, 'run-17', { baseRef: workspace.baseRef, baseSha: workspace.baseSha });
  assert.equal(resumed.worktreeDir, workspace.worktreeDir); assert.equal(resumed.branch, workspace.branch); assert.equal(resumed.baseSha, workspace.baseSha);
});

test('a resumed run keeps its original baseline after upstream advances', async () => {
  const { source, manager, task } = await fixture();
  const workspace = await manager.prepareRun(task, 'run-baseline');
  const originalBase = workspace.baseSha;
  await writeFile(path.join(source, 'SECOND.md'), 'later\n');
  await git(source, ['add', 'SECOND.md']);
  await git(source, ['-c', 'user.name=Patch Poller Test', '-c', 'user.email=patch-poller@example.invalid', 'commit', '-m', 'upstream advance']);
  const resumed = await manager.prepareRun(task, 'run-baseline', { baseRef: workspace.baseRef, baseSha: originalBase });
  assert.equal(resumed.baseSha, originalBase);
});

test('reserved runtime files cannot be force-added as project changes', async () => {
  const { manager, task } = await fixture();
  const workspace = await manager.prepareRun(task, 'run-reserved');
  await mkdir(path.join(workspace.worktreeDir, '.patch-poller'), { recursive: true });
  await writeFile(path.join(workspace.worktreeDir, '.patch-poller', 'evil.txt'), 'not project data\n');
  await git(workspace.worktreeDir, ['add', '-f', '.patch-poller/evil.txt']);
  await assert.rejects(() => manager.validate(workspace), PolicyError);
});
