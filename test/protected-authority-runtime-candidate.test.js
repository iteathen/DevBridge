import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  measureProtectedAuthorityRuntimeCandidate,
  verifyProtectedAuthorityRuntimeAccess,
} from '../src/setup/protected-authority-runtime-candidate.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-runtime-'));
  const packageRoot = path.join(root, 'package');
  const nodeExecutable = path.join(root, 'node');
  await mkdir(path.join(packageRoot, 'src', 'entry'), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  await writeFile(path.join(packageRoot, 'src', 'entry', 'service.mjs'), 'export default true;\n', 'utf8');
  await writeFile(nodeExecutable, 'node-fixture\n', 'utf8');
  return { root, packageRoot, nodeExecutable };
}

test('protected authority runtime measurement is deterministic and changes with package or executable bytes', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const first = await measureProtectedAuthorityRuntimeCandidate(value);
  const same = await measureProtectedAuthorityRuntimeCandidate(value);
  assert.deepEqual(same, first);

  await writeFile(path.join(value.packageRoot, 'src', 'entry', 'service.mjs'), 'export default false;\n', 'utf8');
  const packageChanged = await measureProtectedAuthorityRuntimeCandidate(value);
  assert.notEqual(packageChanged.evidence.packageDigest, first.evidence.packageDigest);
  assert.equal(packageChanged.evidence.nodeDigest, first.evidence.nodeDigest);

  await writeFile(value.nodeExecutable, 'different-node-fixture\n', 'utf8');
  const nodeChanged = await measureProtectedAuthorityRuntimeCandidate(value);
  assert.notEqual(nodeChanged.evidence.nodeDigest, packageChanged.evidence.nodeDigest);
});

test('protected authority runtime measurement rejects package filesystem indirection', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  try {
    await symlink(value.nodeExecutable, path.join(value.packageRoot, 'src', 'entry', 'indirection'));
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('symbolic-link creation is not available to this Windows identity');
      return;
    }
    throw error;
  }
  await assert.rejects(() => measureProtectedAuthorityRuntimeCandidate(value), /filesystem indirection/u);
});

function info(kind, mode, uid = 0, gid = 0) {
  return Object.freeze({
    uid,
    gid,
    mode,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  });
}

test('protected authority runtime access verifies every generation entry and rejects one widened file', async () => {
  const root = path.resolve('/protected/generations', 'a'.repeat(64));
  const packageDirectory = path.join(root, 'package');
  const nodeExecutable = path.join(root, 'bin', 'node');
  const generationManifest = path.join(root, 'generation.json');
  const entry = path.join(packageDirectory, 'src', 'entry.mjs');
  const children = new Map([
    [root, ['bin', 'generation.json', 'package']],
    [path.join(root, 'bin'), ['node']],
    [packageDirectory, ['package.json', 'src']],
    [path.join(packageDirectory, 'src'), ['entry.mjs']],
  ]);
  const records = new Map([
    [root, info('directory', 0o755)],
    [path.join(root, 'bin'), info('directory', 0o755)],
    [nodeExecutable, info('file', 0o555)],
    [generationManifest, info('file', 0o444)],
    [packageDirectory, info('directory', 0o755)],
    [path.join(packageDirectory, 'package.json'), info('file', 0o444)],
    [path.join(packageDirectory, 'src'), info('directory', 0o755)],
    [entry, info('file', 0o444)],
  ]);
  const ports = {
    stat: async (target) => records.get(target),
    readDirectory: async (target) => (children.get(target) ?? []).map((name) => ({ name })),
  };
  const ready = await verifyProtectedAuthorityRuntimeAccess({ generationDirectory: root, packageDirectory, nodeExecutable, generationManifest }, ports);
  assert.equal(ready.ready, true);
  assert.equal(ready.entries, 7);

  records.set(entry, info('file', 0o644));
  await assert.rejects(() => verifyProtectedAuthorityRuntimeAccess({ generationDirectory: root, packageDirectory, nodeExecutable, generationManifest }, ports), /file mode/u);
});
