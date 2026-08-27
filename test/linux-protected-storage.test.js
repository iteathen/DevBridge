import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ensureLinuxProtectedDirectory,
  inspectLinuxProtectedEntry,
  readLinuxProtectedFile,
  writeLinuxProtectedFile,
} from '../src/setup/linux-protected-storage.js';

function fixture() {
  const entries = new Map();
  const calls = [];
  let clock = 1;
  const put = (target, kind, { uid = 0, gid = 0, mode = kind === 'directory' ? 0o755 : 0o600, content = Buffer.alloc(0) } = {}) => {
    entries.set(target, { kind, uid, gid, mode, content: Buffer.from(content), mtimeMs: clock += 1 });
  };
  put('/protected', 'directory');
  const missing = () => { const error = new Error('missing'); error.code = 'ENOENT'; return error; };
  const info = (entry) => Object.freeze({
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode,
    size: entry.content.length,
    mtimeMs: entry.mtimeMs,
    isDirectory: () => entry.kind === 'directory',
    isFile: () => entry.kind === 'file',
    isSymbolicLink: () => entry.kind === 'symlink',
  });
  const ports = {
    async stat(target) {
      calls.push(['stat', target]);
      if (!entries.has(target)) throw missing();
      return info(entries.get(target));
    },
    async makeDirectory(target, options) {
      calls.push(['mkdir', target, options]);
      if (entries.has(target)) { const error = new Error('exists'); error.code = 'EEXIST'; throw error; }
      put(target, 'directory', { mode: options.mode });
    },
    async setOwner(target, uid, gid) {
      calls.push(['chown', target, uid, gid]);
      const entry = entries.get(target);
      entry.uid = uid;
      entry.gid = gid;
    },
    async setMode(target, mode) {
      calls.push(['chmod', target, mode]);
      entries.get(target).mode = mode;
    },
    async load(target) {
      calls.push(['read', target]);
      if (!entries.has(target)) throw missing();
      return Buffer.from(entries.get(target).content);
    },
    async save(target, content, options) {
      calls.push(['write', target, options]);
      if (entries.has(target) && options.flag === 'wx') { const error = new Error('exists'); error.code = 'EEXIST'; throw error; }
      put(target, 'file', { mode: options.mode, content });
    },
    async move(source, destination) {
      calls.push(['rename', source, destination]);
      entries.set(destination, entries.get(source));
      entries.delete(source);
    },
    async remove(target) {
      calls.push(['unlink', target]);
      if (!entries.delete(target)) throw missing();
    },
    async syncDirectory(target) {
      calls.push(['sync', target]);
    },
  };
  return { entries, calls, ports, put };
}

const parent = Object.freeze({ path: '/protected', ownerId: 0, groupId: 0, mode: 0o755 });

test('protected directory creation adopts only admitted root interruption ownership and becomes a no-op', async () => {
  const values = fixture();
  const contract = Object.freeze({ path: '/protected/state', ownerId: 995, groupId: 0, mode: 0o700 });
  const first = await ensureLinuxProtectedDirectory({ contract, parent, adoptOwnerIds: [0] }, values.ports);
  const second = await ensureLinuxProtectedDirectory({ contract, parent, adoptOwnerIds: [0] }, values.ports);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual({ ...values.entries.get(contract.path), content: undefined, mtimeMs: undefined }, {
    kind: 'directory', uid: 995, gid: 0, mode: 0o700, content: undefined, mtimeMs: undefined,
  });
  assert.equal(values.calls.filter(([name]) => name === 'mkdir').length, 1);
  assert.equal(values.calls.filter(([name]) => name === 'sync').length, 1);
});

test('foreign ownership, indirection, and writable parent authority block before mutation', async () => {
  const foreign = fixture();
  foreign.put('/protected/state', 'directory', { uid: 777, gid: 0, mode: 0o700 });
  await assert.rejects(() => ensureLinuxProtectedDirectory({
    contract: { path: '/protected/state', ownerId: 995, groupId: 0, mode: 0o700 },
    parent,
    adoptOwnerIds: [0],
  }, foreign.ports), /ownership is foreign/u);
  assert.equal(foreign.calls.some(([name]) => ['chown', 'chmod', 'sync'].includes(name)), false);

  const linked = fixture();
  linked.put('/protected/state', 'symlink', { uid: 0, gid: 0, mode: 0o700 });
  await assert.rejects(() => ensureLinuxProtectedDirectory({ contract: { path: '/protected/state', ownerId: 0, groupId: 0, mode: 0o700 }, parent }, linked.ports), /not a real directory/u);

  const widened = fixture();
  widened.entries.get('/protected').mode = 0o775;
  await assert.rejects(() => ensureLinuxProtectedDirectory({ contract: { path: '/protected/state', ownerId: 0, groupId: 0, mode: 0o700 }, parent: { ...parent, mode: null } }, widened.ports), /parent authority is invalid/u);
});

test('protected file replacement is bounded, flushed, atomic, exact, and then mutation-free', async () => {
  const values = fixture();
  const contract = Object.freeze({ path: '/protected/record.json', ownerId: 0, groupId: 0, mode: 0o444 });
  const first = await writeLinuxProtectedFile({ contract, parent, content: '{"revision":1}\n' }, values.ports);
  const second = await writeLinuxProtectedFile({ contract, parent, content: '{"revision":1}\n' }, values.ports);
  const third = await writeLinuxProtectedFile({ contract, parent, content: '{"revision":2}\n' }, values.ports);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(third.changed, true);
  assert.equal(values.entries.get(contract.path).content.toString('utf8'), '{"revision":2}\n');
  assert.equal(values.entries.has(`${contract.path}.devbridge-pending`), false);
  assert.equal(values.calls.filter(([name]) => name === 'rename').length, 2);
  assert.equal(values.calls.filter(([name]) => name === 'write').every(([, , options]) => options.flag === 'wx' && options.flush === true), true);
  const read = await readLinuxProtectedFile({ contract }, values.ports);
  assert.equal(read.content.toString('utf8'), '{"revision":2}\n');
});

test('exact owned pending file is recoverable but a foreign or linked pending name blocks', async () => {
  const recoverable = fixture();
  const contract = Object.freeze({ path: '/protected/record.json', ownerId: 0, groupId: 0, mode: 0o444 });
  recoverable.put(`${contract.path}.devbridge-pending`, 'file', { uid: 0, gid: 0, mode: 0o444, content: 'partial' });
  await writeLinuxProtectedFile({ contract, parent, content: 'complete' }, recoverable.ports);
  assert.equal(recoverable.calls.some(([name]) => name === 'unlink'), true);
  assert.equal(recoverable.entries.get(contract.path).content.toString(), 'complete');

  for (const kind of ['file', 'symlink']) {
    const blocked = fixture();
    blocked.put(`${contract.path}.devbridge-pending`, kind, { uid: kind === 'file' ? 777 : 0, gid: 0, mode: 0o444, content: 'foreign' });
    await assert.rejects(() => writeLinuxProtectedFile({ contract, parent, content: 'complete' }, blocked.ports), /pending file is foreign/u);
    assert.equal(blocked.calls.some(([name]) => ['write', 'rename'].includes(name)), false);
  }
});

test('inspection and storage implementation remain independent of lifecycle and provider topology', async () => {
  const values = fixture();
  values.put('/protected/exact', 'file', { uid: 0, gid: 0, mode: 0o444, content: 'exact' });
  const observed = await inspectLinuxProtectedEntry({ contract: { path: '/protected/exact', ownerId: 0, groupId: 0, mode: 0o444 }, kind: 'file' }, values.ports);
  assert.equal(observed.exists && observed.kind && observed.owner && observed.group && observed.mode, true);
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-protected-storage.js', import.meta.url)), 'utf8');
  for (const forbidden of ['lifecycle', 'systemctl', 'libvirt', 'qemu', 'polkit', 'useradd', 'groupadd', 'reconcileProtectedAuthority']) {
    assert.equal(source.includes(forbidden), false, `protected storage gained neighboring authority through ${forbidden}`);
  }
});

test('real Linux filesystem preserves exact atomic storage policy', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-protected-storage-'));
  try {
    await chmod(root, 0o700);
    const rootInfo = await lstat(root);
    const rootContract = { path: root, ownerId: rootInfo.uid, groupId: rootInfo.gid, mode: 0o700 };
    const directoryContract = { path: path.join(root, 'state'), ownerId: rootInfo.uid, groupId: rootInfo.gid, mode: 0o750 };
    const fileContract = { path: path.join(directoryContract.path, 'record.json'), ownerId: rootInfo.uid, groupId: rootInfo.gid, mode: 0o440 };
    const directory = await ensureLinuxProtectedDirectory({ contract: directoryContract, parent: rootContract });
    const installed = await writeLinuxProtectedFile({ contract: fileContract, parent: directoryContract, content: '{"ready":true}\n' });
    const observed = await readLinuxProtectedFile({ contract: fileContract });
    assert.equal(directory.changed, true);
    assert.equal(installed.changed, true);
    assert.equal(observed.content.toString('utf8'), '{"ready":true}\n');
    assert.equal((await lstat(fileContract.path)).mode & 0o7777, 0o440);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
