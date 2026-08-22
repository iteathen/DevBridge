import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRepositoryHistoryInput } from '../src/git/repository-history-input.js';

const subject = '32a782e939339928919b4117af18fcaeb517d741';
const ref = 'refs/remotes/origin/main';

function scratchAt(root) {
  return {
    async directory(id) {
      const target = path.join(root, id);
      await mkdir(target, { recursive: true });
      return target;
    },
  };
}

test('repository history input creates a bounded offline bundle only after exact local lineage proof', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-history-input-'));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'devbridge-history-input-scratch-'));
  const calls = [];
  try {
    const gitClient = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === 'cat-file') return { exitCode: 0, stdout: '', stderr: '' };
        if (args[0] === 'merge-base') return { exitCode: 0, stdout: '', stderr: '' };
        if (args[0] === 'bundle' && args[1] === 'create') {
          await writeFile(args[2], Buffer.from('offline-bundle-bytes'));
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'bundle' && args[1] === 'list-heads') {
          return { exitCode: 0, stdout: `${'a'.repeat(40)} ${ref}\n`, stderr: '' };
        }
        throw new Error(`unexpected git call ${args.join(' ')}`);
      },
    };
    const input = createRepositoryHistoryInput({
      gitClient,
      subject,
      sourceRef: ref,
      destination: 'test/fixtures/devbridge-previous-entry.bundle',
    });
    const loaded = await input.load({ projectDir: root, scratch: scratchAt(scratch), name: 'compatibility.previous-entry' });
    assert.equal(loaded.subject, subject);
    assert.deepEqual(loaded.bytes, Buffer.from('offline-bundle-bytes'));
    assert.deepEqual(calls[0], ['cat-file', '-e', `${subject}^{commit}`]);
    assert.deepEqual(calls[1], ['merge-base', '--is-ancestor', subject, ref]);
    assert.equal(calls.some((args) => ['fetch', 'clone', 'ls-remote'].includes(args[0])), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test('repository history input refuses a subject outside the locally admitted lineage before producing bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-history-reject-'));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'devbridge-history-reject-scratch-'));
  let bundleCreated = false;
  try {
    const gitClient = {
      async run(args) {
        if (args[0] === 'cat-file') return { exitCode: 0, stdout: '', stderr: '' };
        if (args[0] === 'merge-base') return { exitCode: 1, stdout: '', stderr: '' };
        if (args[0] === 'bundle') bundleCreated = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const input = createRepositoryHistoryInput({ gitClient, subject, sourceRef: ref, destination: 'test/fixtures/input.bundle' });
    await assert.rejects(() => input.load({ projectDir: root, scratch: scratchAt(scratch), name: 'fixture' }), /outside the admitted source lineage/u);
    assert.equal(bundleCreated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
