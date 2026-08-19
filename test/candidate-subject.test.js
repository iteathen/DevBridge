import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { candidateArtifactSubject } from '../src/run/candidate-subject.js';

const baselineSha = '1'.repeat(40);

test('artifact subject changes when exact file bytes change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-artifact-bytes-'));
  try {
    await writeFile(path.join(root, 'a.txt'), 'one\n');
    const first = await candidateArtifactSubject({ worktreeDir: root, baselineSha, changedFiles: ['a.txt'] });
    await writeFile(path.join(root, 'a.txt'), 'two\n');
    const second = await candidateArtifactSubject({ worktreeDir: root, baselineSha, changedFiles: ['a.txt'] });
    assert.notEqual(first.subjectDigest, second.subjectDigest);
    assert.notEqual(first.entries[0].sha256, second.entries[0].sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact subject distinguishes deletion and file reappearance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-artifact-delete-'));
  try {
    const deleted = await candidateArtifactSubject({ worktreeDir: root, baselineSha, changedFiles: ['gone.txt'] });
    assert.equal(deleted.entries[0].kind, 'absent');
    await writeFile(path.join(root, 'gone.txt'), 'recreated\n');
    const recreated = await candidateArtifactSubject({ worktreeDir: root, baselineSha, changedFiles: ['gone.txt'] });
    assert.equal(recreated.entries[0].kind, 'file');
    assert.notEqual(deleted.subjectDigest, recreated.subjectDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact subject binds executable mode on POSIX hosts', async (t) => {
  if (process.platform === 'win32') {
    t.skip('executable mode bit is not a stable Windows filesystem contract');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-artifact-mode-'));
  try {
    const file = path.join(root, 'run.sh');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o600);
    const first = await candidateArtifactSubject({ worktreeDir: root, baselineSha, changedFiles: ['run.sh'] });
    await chmod(file, 0o700);
    const second = await candidateArtifactSubject({ worktreeDir: root, baselineSha, changedFiles: ['run.sh'] });
    assert.equal(first.entries[0].executable, false);
    assert.equal(second.entries[0].executable, true);
    assert.notEqual(first.subjectDigest, second.subjectDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact subject binds symlink target without following it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-artifact-link-'));
  try {
    await writeFile(path.join(root, 'target-a.txt'), 'same\n');
    await writeFile(path.join(root, 'target-b.txt'), 'same\n');
    try {
      await symlink('target-a.txt', path.join(root, 'link.txt'));
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`symlink fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const first = await candidateArtifactSubject({ worktreeDir: root, baselineSha, changedFiles: ['link.txt'] });
    await unlink(path.join(root, 'link.txt'));
    await symlink('target-b.txt', path.join(root, 'link.txt'));
    const second = await candidateArtifactSubject({ worktreeDir: root, baselineSha, changedFiles: ['link.txt'] });
    assert.equal(first.entries[0].kind, 'symlink');
    assert.notEqual(first.entries[0].targetSha256, second.entries[0].targetSha256);
    assert.notEqual(first.subjectDigest, second.subjectDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact subject rejects a changed path that crosses a symlinked parent', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-artifact-parent-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'pp-artifact-outside-'));
  try {
    await mkdir(path.join(root, 'src'));
    try {
      await symlink(outside, path.join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`filesystem indirection fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await writeFile(path.join(outside, 'escaped.txt'), 'outside\n');
    await assert.rejects(
      () => candidateArtifactSubject({ worktreeDir: root, baselineSha, changedFiles: ['src/linked/escaped.txt'] }),
      /crosses a symbolic link\/junction/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
