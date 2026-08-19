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
import { PolicyError } from '../src/errors.js';

const exec = promisify(execFile);
async function git(cwd, args) { return exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-baseline-channel-'));
  const source = path.join(root, 'source');
  await exec('git', ['init', '-b', 'main', source]);
  await writeFile(path.join(source, 'BASE.txt'), 'production\n');
  await git(source, ['add', 'BASE.txt']);
  await git(source, ['-c', 'user.name=DevBridge Test', '-c', 'user.email=devbridge@example.invalid', 'commit', '-m', 'production']);
  await git(source, ['checkout', '-b', 'integration/testing']);
  await writeFile(path.join(source, 'BASE.txt'), 'testing-v1\n');
  await git(source, ['add', 'BASE.txt']);
  await git(source, ['-c', 'user.name=DevBridge Test', '-c', 'user.email=devbridge@example.invalid', 'commit', '-m', 'testing']);
  await git(source, ['checkout', 'main']);

  const policy = new WorkspacePolicy({ root: path.join(root, 'managed'), allowedOwners: ['owner'], allowCreate: true });
  await policy.ensureRoot();
  const client = new GitClient({ syntheticHome: path.join(root, 'git-home'), allowFileProtocol: true });
  const manager = new GitWorkspaceManager({
    workspacePolicy: policy,
    gitClient: client,
    remoteUrlResolver: () => source,
    baselineChannels: { testing: 'integration/testing', production: 'main' }
  });
  return { root, source, manager };
}

test('resolves semantic baseline channels locally and persists the exact resolved SHA across upstream movement', async () => {
  const { source, manager } = await fixture();
  const task = {
    issueNumber: 21,
    revision: 'c'.repeat(64),
    envelope: {
      target: { repository: 'owner/repo' },
      controllerPlan: { baselineChannel: 'testing' }
    }
  };
  const workspace = await manager.prepareRun(task, 'run-channel');
  assert.equal(workspace.baselineChannel, 'testing');
  assert.equal(workspace.baseRef, 'origin/integration/testing');
  assert.equal(await readFile(path.join(workspace.worktreeDir, 'BASE.txt'), 'utf8'), 'testing-v1\n');
  const original = workspace.baseSha;

  await git(source, ['checkout', 'integration/testing']);
  await writeFile(path.join(source, 'BASE.txt'), 'testing-v2\n');
  await git(source, ['add', 'BASE.txt']);
  await git(source, ['-c', 'user.name=DevBridge Test', '-c', 'user.email=devbridge@example.invalid', 'commit', '-m', 'testing advance']);
  await git(source, ['checkout', 'main']);

  const resumed = await manager.prepareRun(task, 'run-channel', {
    baseRef: workspace.baseRef,
    baseSha: workspace.baseSha,
    baselineChannel: workspace.baselineChannel
  });
  assert.equal(resumed.baseSha, original);
  assert.equal(await readFile(path.join(resumed.worktreeDir, 'BASE.txt'), 'utf8'), 'testing-v1\n');
});

test('rejects a semantic baseline channel that local policy did not configure', async () => {
  const { manager } = await fixture();
  const task = {
    issueNumber: 22,
    revision: 'd'.repeat(64),
    envelope: { target: { repository: 'owner/repo' }, controllerPlan: { baselineChannel: 'remote-picked' } }
  };
  await assert.rejects(() => manager.prepareRun(task, 'run-denied'), PolicyError);
});
