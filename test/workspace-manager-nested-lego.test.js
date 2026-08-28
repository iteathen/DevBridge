import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaselineAuthority } from '../src/git/workspace-manager/baseline-authority.js';
import { BaselineReconciliation } from '../src/git/workspace-manager/baseline-reconciliation.js';
import { CandidateSealing } from '../src/git/workspace-manager/candidate-sealing.js';
import { PublicationTransaction } from '../src/git/workspace-manager/publication-transaction.js';
import { RepositoryAdmission } from '../src/git/workspace-manager/repository-admission.js';
import { WorkspaceObservation } from '../src/git/workspace-manager/workspace-observation.js';
import { WorktreeLifecycle } from '../src/git/workspace-manager/worktree-lifecycle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function normalizeIdentity(value, label) {
  const normalized = String(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) throw new Error(`${label}:invalid`);
  return normalized;
}

test('repository admission owns origin, fetch, default reference, and exclusion as one contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-admission-owner-'));
  const location = path.join(root, 'project');
  const calls = [];
  try {
    await mkdir(path.join(location, '.git', 'info'), { recursive: true });
    const owner = new RepositoryAdmission({
      run: async (argumentsList, options) => {
        calls.push({ argumentsList, options });
        if (argumentsList[0] === 'remote') return { exitCode: 0, stdout: 'https://example.invalid/owner/project.git\n', stderr: '' };
        if (argumentsList[0] === 'rev-parse' && argumentsList[1] === '--git-path') return { exitCode: 0, stdout: '.git/info/exclude\n', stderr: '' };
        if (argumentsList[0] === 'symbolic-ref') return { exitCode: 0, stdout: 'origin/main\n', stderr: '' };
        if (argumentsList[0] === 'rev-parse') return { exitCode: 0, stdout: `${A}\n`, stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      allowCreate: () => false,
      assertContained: async (value) => assert.ok(path.resolve(value).startsWith(path.resolve(root))),
      location: () => location,
      remote: () => 'https://example.invalid/owner/project.git',
      credential: async () => 'bounded-credential',
      timeoutMs: 25,
      excludedPath: '.control/',
      normalizeIdentity,
      errors: {
        creationDenied: () => new Error('creation-denied'),
        remoteMismatch: () => new Error('remote-mismatch'),
        defaultReference: () => new Error('default-reference'),
      },
    });
    const admitted = await owner.admit('owner/project');
    assert.equal(admitted.baseSha, A);
    assert.equal(admitted.defaultBranch, 'main');
    assert.match(await readFile(path.join(location, '.git', 'info', 'exclude'), 'utf8'), /^\.control\/$/mu);
    assert.equal(calls.some(({ argumentsList }) => argumentsList[0] === 'clone'), false);
    assert.equal(calls.some(({ argumentsList }) => argumentsList[0] === 'fetch'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function baselineOwner(run = async () => ({ exitCode: 0, stdout: `${B}\n`, stderr: '' })) {
  return new BaselineAuthority({
    run,
    channels: { stable: 'release' },
    defaultChannel: null,
    errors: {
      unauthorized: () => new Error('unauthorized'),
      unavailable: () => new Error('unavailable'),
      noLongerAuthorized: () => new Error('removed'),
      channelMismatch: () => new Error('mismatch'),
      invalidReference: () => new Error('invalid-reference'),
      persistedUnavailable: () => new Error('persisted-unavailable'),
    },
  });
}

test('baseline owner accepts only configured semantic channels and exact persisted refs', async () => {
  const record = { repoDir: 'opaque-location', repository: 'opaque-subject', baseRef: 'origin/main', baseSha: A };
  assert.deepEqual(await baselineOwner().select(record, 'stable'), {
    baseRef: 'origin/release', baseSha: B, baselineChannel: 'stable',
  });
  await assert.rejects(() => baselineOwner().select(record, 'unknown'), /unauthorized/u);
  assert.deepEqual(await baselineOwner().observe(record, { baseRef: 'origin/release', baselineChannel: 'stable' }), {
    baseRef: 'origin/release', baseSha: B,
  });
  await assert.rejects(() => baselineOwner().observe(record, { baseRef: 'origin/other', baselineChannel: 'stable' }), /mismatch/u);
});

test('worktree lifecycle creates only the requested branch at the requested baseline without force', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-worktree-owner-'));
  const calls = [];
  try {
    const owner = new WorktreeLifecycle({
      run: async (argumentsList, options) => {
        calls.push({ argumentsList, options });
        return { exitCode: argumentsList[0] === 'show-ref' ? 1 : 0, stdout: '', stderr: '' };
      },
      assertContained: async (value) => assert.ok(path.resolve(value).startsWith(path.resolve(root))),
      errors: { identityMismatch: () => new Error('identity'), branchMismatch: () => new Error('branch') },
    });
    const location = path.join(root, 'runs', 'one');
    await owner.prepare({ repositoryLocation: path.join(root, 'repository'), location, branch: 'topic', baseline: A });
    assert.deepEqual(calls.at(-1).argumentsList, ['worktree', 'add', '-b', 'topic', '--', location, A]);
    assert.equal(calls.at(-1).argumentsList.includes('--force'), false);
    assert.equal(calls.at(-1).argumentsList.includes('-B'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace observation owns exact sorted change projection and validation commands', async () => {
  const calls = [];
  const owner = new WorkspaceObservation({
    run: async (argumentsList) => {
      calls.push(argumentsList);
      const key = argumentsList.join(' ');
      if (key === 'rev-parse HEAD') return { exitCode: 0, stdout: `${C}\n`, stderr: '' };
      if (key.startsWith('status ')) return { exitCode: 0, stdout: ' M b.txt\n', stderr: '' };
      if (key === `diff --name-only ${A}...HEAD`) return { exitCode: 0, stdout: 'b.txt\na.txt\n', stderr: '' };
      if (key === 'ls-files --others --exclude-standard') return { exitCode: 0, stdout: 'c.txt\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    normalizeIdentity,
    reserved: (value) => value.startsWith('.control/'),
    errors: {
      unmerged: () => new Error('unmerged'), reserved: () => new Error('reserved'), diffCheck: () => new Error('diff'),
    },
  });
  const snapshot = await owner.validate({ worktreeDir: 'opaque-location', branch: 'topic', baseSha: A, publicationBaseSha: A });
  assert.deepEqual(snapshot.changedFiles, ['a.txt', 'b.txt', 'c.txt']);
  assert.equal(snapshot.dirty, true);
  assert.equal(calls.some((argumentsList) => argumentsList.join(' ') === `diff --check ${A}...HEAD`), true);
});

test('candidate sealing restores the index before surfacing proposal rejection', async () => {
  const calls = [];
  const owner = new CandidateSealing({
    run: async (argumentsList) => { calls.push(argumentsList); return { exitCode: 0, stdout: '', stderr: '' }; },
    observe: async () => ({ dirty: true }),
    validate: async () => { throw new Error('invalid-proposal'); },
    reserved: () => false,
    commitArguments: () => ['commit'],
    errors: {
      restore: () => new Error('restore'),
      proposal: (error) => new Error(`candidate:${error.message}`),
      reserved: () => new Error('reserved'),
      diffCheck: () => new Error('diff'),
      remainedDirty: () => new Error('dirty'),
    },
  });
  await assert.rejects(() => owner.seal({ worktreeDir: 'opaque-location' }, {}), /candidate:invalid-proposal/u);
  assert.deepEqual(calls, [['reset', '--quiet', 'HEAD', '--', '.']]);
});

test('baseline reconciliation rejects rewritten ancestry before reset or rebase', async () => {
  const calls = [];
  const owner = new BaselineReconciliation({
    run: async (argumentsList) => {
      calls.push(argumentsList);
      return { exitCode: 1, stdout: '', stderr: '' };
    },
    validate: async () => { throw new Error('must-not-validate'); },
    normalizeIdentity,
    rebaseArguments: () => ['rebase'],
    errors: {
      historyRewrite: () => new Error('history-rewrite'),
      compareBaseline: () => new Error('compare-baseline'),
      candidateAncestry: () => new Error('candidate-ancestry'),
      compareCandidate: () => new Error('compare-candidate'),
      abort: () => new Error('abort'),
      restoreMismatch: () => new Error('restore'),
      conflict: () => new Error('conflict'),
      becameDirty: () => new Error('dirty'),
    },
  });
  await assert.rejects(() => owner.reconcile(
    { repoDir: 'repository', worktreeDir: 'worktree', branch: 'topic', baseRef: 'origin/main', baseSha: A, publicationBaseSha: A },
    { before: { headSha: C }, current: { baseRef: 'origin/main', baseSha: B } },
  ), /history-rewrite/u);
  assert.deepEqual(calls, [['merge-base', '--is-ancestor', A, B]]);
});

test('publication transaction uses exact known predecessor lease and reconciles ambiguous completion', async () => {
  const calls = [];
  let observations = 0;
  const owner = new PublicationTransaction({
    run: async (argumentsList, options) => {
      calls.push({ argumentsList, options });
      if (argumentsList[0] === 'ls-remote') {
        observations += 1;
        return { exitCode: 0, stdout: `${observations === 1 ? A : C}\trefs/heads/topic\n`, stderr: '' };
      }
      return { exitCode: 1, timedOut: true, stdout: '', stderr: 'uncertain' };
    },
    timeoutMs: 25,
    normalizeIdentity,
    error: (message) => new Error(message),
    unexpectedHead: (head) => new Error(`unexpected:${head}`),
  });
  const workspace = {
    branch: 'topic', worktreeDir: 'opaque-location', remoteUrl: 'https://example.invalid/owner/project.git', taskBranchKnownRemoteHeads: [A],
  };
  const result = await owner.publish(workspace, {
    snapshot: { headSha: C }, expectedHeadSha: C, ref: 'refs/heads/topic', credential: 'bounded-credential',
  });
  assert.deepEqual(calls[1].argumentsList, [
    'push', `--force-with-lease=refs/heads/topic:${A}`, 'origin', `${C}:refs/heads/topic`,
  ]);
  assert.equal(result.reconciled, true);
  assert.deepEqual(workspace.taskBranchKnownRemoteHeads, [A, C]);
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(candidate));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(candidate);
  }
  return files;
}

test('nested Git workspace owners import no sibling and only the parent exposes their topology', async () => {
  const directory = path.join(ROOT, 'src', 'git', 'workspace-manager');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(names, [
    'baseline-authority.js',
    'baseline-reconciliation.js',
    'candidate-sealing.js',
    'publication-transaction.js',
    'repository-admission.js',
    'workspace-observation.js',
    'worktree-lifecycle.js',
  ]);
  const forbidden = /(?:from ['"]\.\.?\/|devbridge|github|codex|hyper-?v|libvirt|qemu|powershell|virsh|workspace-manager|child_process|\bspawn\b|\bexecFile\b)/imu;
  for (const name of names) {
    const source = await readFile(path.join(directory, name), 'utf8');
    assert.doesNotMatch(source, forbidden, `${name} must remain sibling- and topology-agnostic`);
  }

  const parentPath = path.join(ROOT, 'src', 'git', 'workspace-manager.js');
  const parent = await readFile(parentPath, 'utf8');
  for (const name of names) assert.match(parent, new RegExp(`\\./workspace-manager/${name.replace('.', '\\.')}['"]`, 'u'));

  for (const file of await sourceFiles(path.join(ROOT, 'src'))) {
    if (file === parentPath || file.startsWith(`${directory}${path.sep}`)) continue;
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from ['"][^'"]*workspace-manager\//u, `${path.relative(ROOT, file)} must depend only on the parent surface`);
  }
});
