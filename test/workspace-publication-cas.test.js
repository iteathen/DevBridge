import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BaselineReverificationRequiredError, PolicyError } from '../src/errors.js';
import { GitClient } from '../src/git/git-client.js';
import { GitWorkspaceManager } from '../src/git/workspace-manager.js';
import { WorkspacePolicy } from '../src/security/workspace-policy.js';

const exec = promisify(execFile);
async function git(cwd, args) { return exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }

class RecordingGitClient {
  constructor(inner) {
    this.inner = inner;
    this.calls = [];
    this.ambiguousNextPush = false;
  }

  async run(args, options = {}) {
    this.calls.push({ args: [...args], options: { ...options } });
    const result = await this.inner.run(args, options);
    if (args[0] === 'push' && this.ambiguousNextPush) {
      this.ambiguousNextPush = false;
      return { ...result, exitCode: null, timedOut: true };
    }
    return result;
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-publication-cas-'));
  const source = path.join(root, 'source');
  await exec('git', ['init', '-b', 'main', source]);
  await writeFile(path.join(source, 'README.md'), 'one\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['-c', 'user.name=Patch Poller Test', '-c', 'user.email=patch-poller@example.invalid', 'commit', '-m', 'initial']);

  const policy = new WorkspacePolicy({ root: path.join(root, 'managed'), allowedOwners: ['owner'], allowCreate: true });
  await policy.ensureRoot();
  const raw = new GitClient({ syntheticHome: path.join(root, 'git-home'), allowFileProtocol: true });
  const client = new RecordingGitClient(raw);
  const manager = new GitWorkspaceManager({ workspacePolicy: policy, gitClient: client, remoteUrlResolver: () => source });
  const task = { issueNumber: 49, revision: 'a'.repeat(64), envelope: { target: { repository: 'owner/repo' } } };
  const workspace = await manager.prepareRun(task, 'run-publication');
  return { root, source, client, manager, task, workspace };
}

async function createCandidate(manager, task, workspace, content = 'candidate\n') {
  await writeFile(path.join(workspace.worktreeDir, 'README.md'), content);
  return manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
}

async function advanceSource(source, file = 'UPSTREAM.md') {
  await writeFile(path.join(source, file), 'upstream\n');
  await git(source, ['add', file]);
  await git(source, ['-c', 'user.name=Patch Poller Test', '-c', 'user.email=patch-poller@example.invalid', 'commit', '-m', `advance ${file}`]);
  return (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
}

function pushCalls(client) {
  return client.calls.filter(({ args }) => args[0] === 'push');
}

test('first task-branch publication uses an explicitly empty expected remote head', async () => {
  const { source, client, manager, task, workspace } = await fixture();
  const sealed = await createCandidate(manager, task, workspace);
  const publication = await manager.publishTaskBranch(workspace);
  const ref = `refs/heads/${workspace.branch}`;
  const pushes = pushCalls(client);
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].args.includes(`--force-with-lease=${ref}:`));
  assert.equal(publication.headSha, sealed.headSha);
  assert.deepEqual(workspace.taskBranchKnownRemoteHeads, [sealed.headSha]);
  assert.equal((await git(source, ['rev-parse', ref])).stdout.trim(), sealed.headSha);
});

test('rebased task branch rewrite binds force-with-lease to the exact confirmed remote predecessor head', async () => {
  const { source, client, manager, task, workspace } = await fixture();
  const first = await createCandidate(manager, task, workspace);
  await manager.publishTaskBranch(workspace);
  assert.deepEqual(workspace.taskBranchKnownRemoteHeads, [first.headSha]);
  await advanceSource(source);

  await assert.rejects(
    manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision }),
    BaselineReverificationRequiredError
  );
  const rebased = await manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
  assert.notEqual(rebased.headSha, first.headSha);
  const publication = await manager.publishTaskBranch(workspace);
  const ref = `refs/heads/${workspace.branch}`;
  const pushes = pushCalls(client);
  assert.equal(pushes.length, 2);
  assert.ok(pushes[1].args.includes(`--force-with-lease=${ref}:${first.headSha}`));
  assert.equal(publication.previousRemoteHeadSha, first.headSha);
  assert.deepEqual(workspace.taskBranchKnownRemoteHeads, [first.headSha, rebased.headSha]);
  assert.equal((await git(source, ['rev-parse', ref])).stdout.trim(), rebased.headSha);
});

test('a local pre-rebase candidate head never becomes rewrite authority unless PATCH-POLLER confirmed it remotely', async () => {
  const { source, client, manager, task, workspace } = await fixture();
  const first = await createCandidate(manager, task, workspace);
  assert.deepEqual(workspace.taskBranchKnownRemoteHeads, []);

  const ref = `refs/heads/${workspace.branch}`;
  await git(workspace.worktreeDir, ['push', 'origin', `${first.headSha}:${ref}`]);
  assert.equal((await git(source, ['rev-parse', ref])).stdout.trim(), first.headSha);
  assert.deepEqual(workspace.taskBranchKnownRemoteHeads, []);

  await advanceSource(source);
  await assert.rejects(
    manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision }),
    BaselineReverificationRequiredError
  );
  const rebased = await manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
  assert.notEqual(rebased.headSha, first.headSha);
  assert.deepEqual(workspace.taskBranchKnownRemoteHeads, []);

  const pushesBefore = pushCalls(client).length;
  await assert.rejects(
    manager.publishTaskBranch(workspace),
    (error) => {
      assert.ok(error instanceof PolicyError);
      assert.match(error.message, /unexpected head/u);
      return true;
    }
  );
  assert.equal(pushCalls(client).length, pushesBefore);
  assert.equal((await git(source, ['rev-parse', ref])).stdout.trim(), first.headSha);
});

test('unexpected remote task-branch mutation is never overwritten', async () => {
  const { source, client, manager, task, workspace } = await fixture();
  const first = await createCandidate(manager, task, workspace);
  await manager.publishTaskBranch(workspace);
  const newBase = await advanceSource(source);
  await assert.rejects(
    manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision }),
    BaselineReverificationRequiredError
  );
  const rebased = await manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
  assert.notEqual(rebased.headSha, first.headSha);

  const ref = `refs/heads/${workspace.branch}`;
  await git(source, ['update-ref', ref, newBase]);
  const pushesBefore = pushCalls(client).length;
  await assert.rejects(
    manager.publishTaskBranch(workspace),
    (error) => {
      assert.ok(error instanceof PolicyError);
      assert.match(error.message, /unexpected head/u);
      return true;
    }
  );
  assert.equal(pushCalls(client).length, pushesBefore);
  assert.equal((await git(source, ['rev-parse', ref])).stdout.trim(), newBase);
});

test('ambiguous push reconciles as success only after the exact intended remote head is observed', async () => {
  const { source, client, manager, task, workspace } = await fixture();
  const sealed = await createCandidate(manager, task, workspace);
  client.ambiguousNextPush = true;
  const publication = await manager.publishTaskBranch(workspace);
  const ref = `refs/heads/${workspace.branch}`;
  assert.equal(publication.headSha, sealed.headSha);
  assert.equal(publication.reconciled, true);
  assert.deepEqual(workspace.taskBranchKnownRemoteHeads, [sealed.headSha]);
  assert.equal((await git(source, ['rev-parse', ref])).stdout.trim(), sealed.headSha);
});

test('already-converged remote task branch is idempotent and records the observed exact head without pushing again', async () => {
  const { client, manager, task, workspace } = await fixture();
  const sealed = await createCandidate(manager, task, workspace);
  await manager.publishTaskBranch(workspace);
  workspace.taskBranchKnownRemoteHeads = [];
  const pushesBefore = pushCalls(client).length;
  const publication = await manager.publishTaskBranch(workspace);
  assert.equal(publication.reconciled, true);
  assert.equal(publication.headSha, sealed.headSha);
  assert.deepEqual(workspace.taskBranchKnownRemoteHeads, [sealed.headSha]);
  assert.equal(pushCalls(client).length, pushesBefore);
});
