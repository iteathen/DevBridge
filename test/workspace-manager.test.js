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
import {
  BaselineReconciliationError,
  BaselineReverificationRequiredError,
  PolicyError,
} from '../src/errors.js';
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

async function advanceSource(source, file = 'SECOND.md', content = 'later\n', message = 'upstream advance') {
  await writeFile(path.join(source, file), content);
  await git(source, ['add', file]);
  await git(source, ['-c', 'user.name=Patch Poller Test', '-c', 'user.email=patch-poller@example.invalid', 'commit', '-m', message]);
  return (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
}

test('provisions, seals, and resumes an isolated managed worktree while ignoring runtime exchange files', async () => {
  const { manager, task } = await fixture();
  const workspace = await manager.prepareRun(task, 'run-17');
  assert.equal(await readFile(path.join(workspace.worktreeDir, 'README.md'), 'utf8'), 'one\n');
  assert.match(workspace.branch, /^patchpoller\/issue-17-/);
  assert.equal(workspace.publicationBaseSha, workspace.baseSha);
  await writeFile(path.join(workspace.worktreeDir, 'README.md'), 'two\n');
  await mkdir(path.join(workspace.worktreeDir, '.patch-poller'), { recursive: true });
  await writeFile(path.join(workspace.worktreeDir, '.patch-poller', 'context.json'), '{}\n');
  const snapshot = await manager.snapshot(workspace);
  assert.equal(snapshot.dirty, true);
  assert.deepEqual(snapshot.changedFiles, ['README.md']);
  const sealed = await manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
  assert.equal(sealed.dirty, false);
  assert.notEqual(sealed.headSha, sealed.publicationBaseSha);
  assert.deepEqual(sealed.changedFiles, ['README.md']);
  const resumed = await manager.prepareRun(task, 'run-17', {
    baseRef: workspace.baseRef,
    baseSha: workspace.baseSha,
    publicationBaseSha: workspace.publicationBaseSha,
    taskBranchKnownRemoteHeads: workspace.taskBranchKnownRemoteHeads
  });
  assert.equal(resumed.worktreeDir, workspace.worktreeDir);
  assert.equal(resumed.branch, workspace.branch);
  assert.equal(resumed.baseSha, workspace.baseSha);
  assert.equal(resumed.publicationBaseSha, workspace.publicationBaseSha);
  assert.deepEqual(resumed.taskBranchKnownRemoteHeads, workspace.taskBranchKnownRemoteHeads);
});

test('a resumed run keeps its original baseline after upstream advances', async () => {
  const { source, manager, task } = await fixture();
  const workspace = await manager.prepareRun(task, 'run-baseline');
  const originalBase = workspace.baseSha;
  await advanceSource(source);
  const resumed = await manager.prepareRun(task, 'run-baseline', {
    baseRef: workspace.baseRef,
    baseSha: originalBase,
    publicationBaseSha: workspace.publicationBaseSha
  });
  assert.equal(resumed.baseSha, originalBase);
  assert.equal(resumed.publicationBaseSha, originalBase);
});

test('fast-forward drift rebases a sealed candidate while preserving the immutable start baseline', async () => {
  const { source, manager, task } = await fixture();
  const workspace = await manager.prepareRun(task, 'run-drift');
  const originalBase = workspace.baseSha;
  await writeFile(path.join(workspace.worktreeDir, 'README.md'), 'candidate\n');
  const firstSeal = await manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
  const preRebaseHead = firstSeal.headSha;
  const newBase = await advanceSource(source);

  await assert.rejects(
    manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision }),
    (error) => {
      assert.ok(error instanceof BaselineReverificationRequiredError);
      assert.equal(error.reconciliation.fromBaseSha, originalBase);
      assert.equal(error.reconciliation.toBaseSha, newBase);
      assert.equal(error.reconciliation.fromHeadSha, preRebaseHead);
      return true;
    }
  );

  assert.equal(workspace.baseSha, originalBase);
  assert.equal(workspace.publicationBaseSha, newBase);
  assert.deepEqual(workspace.taskBranchKnownRemoteHeads, []);
  const rebased = await manager.validate(workspace);
  assert.equal(rebased.dirty, false);
  assert.deepEqual(rebased.changedFiles, ['README.md']);
  assert.equal(await readFile(path.join(workspace.worktreeDir, 'SECOND.md'), 'utf8'), 'later\n');
  assert.notEqual(rebased.headSha, preRebaseHead);
  const verified = await manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
  assert.equal(verified.publicationBaseSha, newBase);
  assert.deepEqual(verified.changedFiles, ['README.md']);
});

test('no-project-diff drift advances only the publication baseline and still requires reverification', async () => {
  const { source, manager, task } = await fixture();
  const workspace = await manager.prepareRun(task, 'run-noop-drift');
  const originalBase = workspace.baseSha;
  const newBase = await advanceSource(source);

  await assert.rejects(
    manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision }),
    BaselineReverificationRequiredError
  );
  const snapshot = await manager.validate(workspace);
  assert.equal(workspace.baseSha, originalBase);
  assert.equal(snapshot.publicationBaseSha, newBase);
  assert.equal(snapshot.headSha, newBase);
  assert.deepEqual(snapshot.changedFiles, []);
});

test('rebase conflict aborts and restores the exact sealed candidate head', async () => {
  const { source, manager, task } = await fixture();
  const workspace = await manager.prepareRun(task, 'run-conflict');
  await writeFile(path.join(workspace.worktreeDir, 'README.md'), 'candidate\n');
  const sealed = await manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
  const originalPublicationBase = workspace.publicationBaseSha;
  await writeFile(path.join(source, 'README.md'), 'upstream\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['-c', 'user.name=Patch Poller Test', '-c', 'user.email=patch-poller@example.invalid', 'commit', '-m', 'conflicting upstream advance']);

  await assert.rejects(
    manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision }),
    (error) => {
      assert.ok(error instanceof BaselineReconciliationError);
      assert.equal(error.kind, 'conflict');
      assert.ok(error.files.includes('README.md'));
      return true;
    }
  );

  const restored = await manager.validate(workspace);
  assert.equal(restored.headSha, sealed.headSha);
  assert.equal(restored.publicationBaseSha, originalPublicationBase);
  assert.equal(restored.dirty, false);
  assert.deepEqual(restored.unmergedFiles, []);
  assert.equal(await readFile(path.join(workspace.worktreeDir, 'README.md'), 'utf8'), 'candidate\n');
});

test('rewritten upstream baseline history is not automatically accepted', async () => {
  const { source, manager, task } = await fixture();
  const workspace = await manager.prepareRun(task, 'run-rewritten-upstream');
  const originalBase = workspace.baseSha;
  await git(source, ['checkout', '--orphan', 'rewritten']);
  await git(source, ['rm', '-rf', '.']);
  await writeFile(path.join(source, 'README.md'), 'rewritten root\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['-c', 'user.name=Patch Poller Test', '-c', 'user.email=patch-poller@example.invalid', 'commit', '-m', 'rewritten root']);
  await git(source, ['branch', '-M', 'main']);

  await assert.rejects(
    manager.sealCandidate(workspace, { issueNumber: task.issueNumber, revision: task.revision }),
    (error) => {
      assert.ok(error instanceof BaselineReconciliationError);
      assert.equal(error.kind, 'upstream-history-rewrite');
      return true;
    }
  );
  const snapshot = await manager.validate(workspace);
  assert.equal(snapshot.baseSha, originalBase);
  assert.equal(snapshot.publicationBaseSha, originalBase);
  assert.equal(snapshot.headSha, originalBase);
});

test('reserved runtime files cannot be force-added as project changes', async () => {
  const { manager, task } = await fixture();
  const workspace = await manager.prepareRun(task, 'run-reserved');
  await mkdir(path.join(workspace.worktreeDir, '.patch-poller'), { recursive: true });
  await writeFile(path.join(workspace.worktreeDir, '.patch-poller', 'evil.txt'), 'not project data\n');
  await git(workspace.worktreeDir, ['add', '-f', '.patch-poller/evil.txt']);
  await assert.rejects(() => manager.validate(workspace), PolicyError);
});
