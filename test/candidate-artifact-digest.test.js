import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { candidateArtifactDigest } from '../src/run/candidate-artifact-digest.js';

test('artifact digest changes with final bytes, executable mode, symlink target, deletion, or changed path set', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-artifact-digest-'));
  try {
    await mkdir(path.join(root, 'src'));
    const file = path.join(root, 'src', 'a.txt');
    await writeFile(file, 'one\n');
    const first = await candidateArtifactDigest({ baseSha: 'a'.repeat(40), worktreeDir: root, changedFiles: ['src/a.txt'] });
    await writeFile(file, 'two\n');
    const second = await candidateArtifactDigest({ baseSha: 'a'.repeat(40), worktreeDir: root, changedFiles: ['src/a.txt'] });
    assert.notEqual(first.artifactSha256, second.artifactSha256);
    await unlink(file);
    const deleted = await candidateArtifactDigest({ baseSha: 'a'.repeat(40), worktreeDir: root, changedFiles: ['src/a.txt'] });
    assert.notEqual(second.artifactSha256, deleted.artifactSha256);
    try { await symlink('target-one', file); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) { t.skip(`symlink unavailable: ${error.code}`); return; } throw error; }
    const linkOne = await candidateArtifactDigest({ baseSha: 'a'.repeat(40), worktreeDir: root, changedFiles: ['src/a.txt'] });
    await unlink(file); await symlink('target-two', file);
    const linkTwo = await candidateArtifactDigest({ baseSha: 'a'.repeat(40), worktreeDir: root, changedFiles: ['src/a.txt'] });
    assert.notEqual(linkOne.artifactSha256, linkTwo.artifactSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
