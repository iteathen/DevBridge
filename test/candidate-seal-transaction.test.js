import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CandidateValidationError } from '../src/errors.js';
import { GitClient } from '../src/git/git-client.js';
import { GitWorkspaceManager } from '../src/git/workspace-manager.js';
import { WorkspacePolicy } from '../src/security/workspace-policy.js';

const exec = promisify(execFile);
async function git(cwd, args) {
  return exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

test('rejected candidate seal restores the index, then accepts ordinary CRLF after repair', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-candidate-transaction-'));
  const source = path.join(root, 'source');
  await exec('git', ['init', '-b', 'main', source]);
  await writeFile(path.join(source, 'README.md'), 'base\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['-c', 'user.name=Patch Poller Test', '-c', 'user.email=devbridge@example.invalid', 'commit', '-m', 'initial']);

  const policy = new WorkspacePolicy({ root: path.join(root, 'managed'), allowedOwners: ['owner'], allowCreate: true });
  await policy.ensureRoot();
  const client = new GitClient({ syntheticHome: path.join(root, 'git-home'), allowFileProtocol: true });
  const manager = new GitWorkspaceManager({ workspacePolicy: policy, gitClient: client, remoteUrlResolver: () => source });
  const task = { issueNumber: 4, revision: 'b'.repeat(64), envelope: { target: { repository: 'owner/repo' } } };
  const workspace = await manager.prepareRun(task, 'run-candidate-transaction');

  const target = path.join(workspace.worktreeDir, 'test', 'fixtures', 'bad.txt');
  await mkdir(path.dirname(target), { recursive: true });
  const bad = '\uFEFFDevBridge live smoke test 001 \r\n\r\n';
  await writeFile(target, bad, 'utf8');

  await assert.rejects(
    () => manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision }),
    CandidateValidationError
  );

  const stagedAfterReject = await git(workspace.worktreeDir, ['diff', '--cached', '--name-only']);
  assert.equal(stagedAfterReject.stdout.trim(), '');
  assert.equal(await readFile(target, 'utf8'), bad);
  const rejectedSnapshot = await manager.snapshot(workspace);
  assert.equal(rejectedSnapshot.dirty, true);
  assert.deepEqual(rejectedSnapshot.changedFiles, ['test/fixtures/bad.txt']);

  const repairedCrLf = 'DevBridge live smoke test 001\r\n';
  await writeFile(target, repairedCrLf, 'utf8');
  const sealed = await manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
  assert.equal(sealed.dirty, false);
  assert.deepEqual(sealed.changedFiles, ['test/fixtures/bad.txt']);
  assert.notEqual(sealed.headSha, sealed.baseSha);
});
