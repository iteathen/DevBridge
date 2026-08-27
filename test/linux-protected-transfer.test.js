import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  transferLinuxProtectedFile,
  verifyLinuxProtectedFile,
} from '../src/setup/linux-protected-storage.js';

const FLAGS = Object.freeze({
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_CREAT: 0x40,
  O_EXCL: 0x80,
  O_NOFOLLOW: 0x20000,
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture({
  maximumRead = Number.MAX_SAFE_INTEGER,
  maximumWrite = Number.MAX_SAFE_INTEGER,
  afterRead = null,
  failDirectorySyncAt = null,
} = {}) {
  const entries = new Map();
  const calls = [];
  let clock = 10;
  let nextInode = 100;
  const tick = () => { clock += 1; return clock; };
  const put = (target, kind, {
    uid = 0,
    gid = 0,
    mode = kind === 'directory' ? 0o700 : 0o600,
    content = Buffer.alloc(0),
    nlink = 1,
  } = {}) => {
    const time = tick();
    const entry = {
      kind,
      uid,
      gid,
      mode,
      content: Buffer.from(content),
      nlink,
      dev: 1,
      ino: nextInode += 1,
      mtimeMs: time,
      ctimeMs: time,
    };
    entries.set(target, entry);
    return entry;
  };
  put('/protected', 'directory');
  const missing = () => { const error = new Error('missing'); error.code = 'ENOENT'; return error; };
  const info = (entry) => Object.freeze({
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode,
    size: entry.content.length,
    nlink: entry.nlink,
    dev: entry.dev,
    ino: entry.ino,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
    isDirectory: () => entry.kind === 'directory',
    isFile: () => entry.kind === 'file',
    isSymbolicLink: () => entry.kind === 'symlink',
  });
  const ports = {
    openFlags: FLAGS,
    async stat(target) {
      calls.push(['stat', target]);
      const entry = entries.get(target);
      if (!entry) throw missing();
      return info(entry);
    },
    async openFile(target, flags, requestedMode) {
      calls.push(['open', target, flags, requestedMode]);
      let entry = entries.get(target);
      if (entry?.kind === 'symlink' && (flags & FLAGS.O_NOFOLLOW) !== 0) {
        const error = new Error('linked'); error.code = 'ELOOP'; throw error;
      }
      if (entry && (flags & FLAGS.O_CREAT) !== 0 && (flags & FLAGS.O_EXCL) !== 0) {
        const error = new Error('exists'); error.code = 'EEXIST'; throw error;
      }
      if (!entry && (flags & FLAGS.O_CREAT) !== 0) entry = put(target, 'file', { mode: requestedMode });
      if (!entry) throw missing();
      let closed = false;
      const active = () => {
        if (closed) throw new Error('closed');
        return entry;
      };
      return {
        async stat() { return info(active()); },
        async read(buffer, offset, length, position) {
          const selected = active();
          const bytesRead = Math.min(length, maximumRead, Math.max(0, selected.content.length - position));
          selected.content.copy(buffer, offset, position, position + bytesRead);
          calls.push(['read', target, bytesRead, position]);
          if (afterRead != null) afterRead({ target, entry: selected, tick, calls });
          return { bytesRead, buffer };
        },
        async write(buffer, offset, length, position) {
          const selected = active();
          const bytesWritten = Math.min(length, maximumWrite);
          const required = position + bytesWritten;
          if (selected.content.length < required) {
            const expanded = Buffer.alloc(required);
            selected.content.copy(expanded);
            selected.content = expanded;
          }
          buffer.copy(selected.content, position, offset, offset + bytesWritten);
          const time = tick();
          selected.mtimeMs = time;
          selected.ctimeMs = time;
          calls.push(['write', target, bytesWritten, position]);
          return { bytesWritten, buffer };
        },
        async chown(uid, gid) {
          const selected = active();
          selected.uid = uid;
          selected.gid = gid;
          selected.ctimeMs = tick();
          calls.push(['chown', target, uid, gid]);
        },
        async chmod(value) {
          const selected = active();
          selected.mode = value;
          selected.ctimeMs = tick();
          calls.push(['chmod', target, value]);
        },
        async sync() { active(); calls.push(['sync-file', target]); },
        async close() { closed = true; calls.push(['close', target]); },
      };
    },
    async move(source, destination) {
      calls.push(['rename', source, destination]);
      const entry = entries.get(source);
      if (!entry) throw missing();
      entries.set(destination, entry);
      entries.delete(source);
    },
    async remove(target) {
      calls.push(['unlink', target]);
      if (!entries.delete(target)) throw missing();
    },
    async syncDirectory(target) {
      calls.push(['sync-directory', target]);
      const count = calls.filter(([name]) => name === 'sync-directory').length;
      if (count === failDirectorySyncAt) throw new Error('directory sync interrupted');
    },
  };
  return { calls, entries, ports, put };
}

const parent = Object.freeze({ path: '/protected', ownerId: 0, groupId: 0, mode: 0o700 });

function request(content, overrides = {}) {
  return {
    input: { path: '/source.bin', size: content.length, digest: sha256(content) },
    output: { path: '/protected/output.bin', ownerId: 995, groupId: 994, mode: 0o440 },
    parent,
    creatorIds: { ownerId: 0, groupId: 0 },
    ...overrides,
  };
}

test('streamed protected transfer installs exact bytes and reconciles an exact no-op', async () => {
  const values = fixture();
  const content = Buffer.from('measured artifact bytes');
  values.put('/source.bin', 'file', { content });
  const first = await transferLinuxProtectedFile(request(content), values.ports);
  const second = await transferLinuxProtectedFile(request(content), values.ports);
  assert.deepEqual(first, {
    protocol: 'devbridge/linux-protected-storage-v1',
    path: '/protected/output.bin',
    kind: 'file',
    size: content.length,
    digest: sha256(content),
    changed: true,
  });
  assert.equal(second.changed, false);
  assert.deepEqual(values.entries.get('/protected/output.bin').content, content);
  assert.equal(values.entries.get('/protected/output.bin').uid, 995);
  assert.equal(values.entries.get('/protected/output.bin').gid, 994);
  assert.equal(values.entries.get('/protected/output.bin').mode, 0o440);
  assert.equal(values.calls.filter(([name]) => name === 'rename').length, 1);
  assert.equal(values.calls.filter(([name]) => name === 'sync-file').length, 1);
  assert.equal(values.calls.filter(([name]) => name === 'sync-directory').length, 2);
  const verified = await verifyLinuxProtectedFile({
    contract: request(content).output,
    size: content.length,
    digest: sha256(content),
  }, values.ports);
  assert.equal(verified.ready, true);
  await assert.rejects(() => verifyLinuxProtectedFile({
    contract: request(content).output,
    size: content.length,
    digest: sha256('wrong'),
  }, values.ports), /digest is invalid/u);
});

test('digest failure leaves only an admitted pending state that the exact retry recovers', async () => {
  const values = fixture();
  const content = Buffer.from('recoverable transfer');
  values.put('/source.bin', 'file', { content });
  await assert.rejects(() => transferLinuxProtectedFile(request(content, {
    input: { path: '/source.bin', size: content.length, digest: sha256('different') },
  }), values.ports), /input digest is invalid/u);
  const pending = values.entries.get('/protected/output.bin.devbridge-pending');
  assert.equal(pending.uid, 0);
  assert.equal(pending.gid, 0);
  assert.equal(pending.mode, 0o600);
  const completed = await transferLinuxProtectedFile(request(content), values.ports);
  assert.equal(completed.changed, true);
  assert.equal(values.calls.filter(([name]) => name === 'unlink').length, 1);
  assert.equal(values.entries.has('/protected/output.bin.devbridge-pending'), false);
});

test('an installed replacement is reconciled after directory durability is interrupted', async () => {
  const values = fixture({ failDirectorySyncAt: 1 });
  const content = Buffer.from('durability reconciliation');
  values.put('/source.bin', 'file', { content });
  await assert.rejects(() => transferLinuxProtectedFile(request(content), values.ports), /directory sync interrupted/u);
  assert.equal(values.entries.has('/protected/output.bin'), true);
  assert.equal(values.entries.has('/protected/output.bin.devbridge-pending'), false);
  const reconciled = await transferLinuxProtectedFile(request(content), values.ports);
  assert.equal(reconciled.changed, false);
  assert.equal(values.calls.filter(([name]) => name === 'rename').length, 1);
  assert.equal(values.calls.filter(([name]) => name === 'sync-directory').length, 2);
});

test('source descriptor drift fails before rename and preserves recoverable evidence', async () => {
  let changed = false;
  const values = fixture({
    afterRead({ target, entry, tick }) {
      if (target === '/source.bin' && !changed) {
        entry.ctimeMs = tick();
        changed = true;
      }
    },
  });
  const content = Buffer.from('changing source evidence');
  values.put('/source.bin', 'file', { content });
  await assert.rejects(() => transferLinuxProtectedFile(request(content), values.ports), /file changed while open/u);
  assert.equal(values.calls.some(([name]) => name === 'rename'), false);
  assert.equal(values.entries.get('/protected/output.bin.devbridge-pending').mode, 0o600);
});

test('linked or foreign output and pending state fail closed before replacement', async () => {
  const content = Buffer.from('bounded bytes');
  const linkedOutput = fixture();
  linkedOutput.put('/source.bin', 'file', { content });
  linkedOutput.put('/protected/output.bin', 'file', { uid: 995, gid: 994, mode: 0o440, content, nlink: 2 });
  await assert.rejects(() => transferLinuxProtectedFile(request(content), linkedOutput.ports), /output authority is invalid/u);
  assert.equal(linkedOutput.calls.some(([name]) => name === 'rename'), false);

  const foreignOutput = fixture();
  foreignOutput.put('/source.bin', 'file', { content });
  foreignOutput.put('/protected/output.bin', 'file', { uid: 777, gid: 994, mode: 0o440, content });
  await assert.rejects(() => transferLinuxProtectedFile(request(content), foreignOutput.ports), /output authority is invalid/u);
  assert.equal(foreignOutput.calls.some(([name]) => name === 'open'), false);

  const linkedInput = fixture();
  linkedInput.put('/source.bin', 'symlink', { content });
  await assert.rejects(() => transferLinuxProtectedFile(request(content), linkedInput.ports), /linked/u);
  assert.equal(linkedInput.entries.has('/protected/output.bin.devbridge-pending'), false);

  for (const state of [
    { kind: 'file', uid: 777, gid: 0, mode: 0o600 },
    { kind: 'symlink', uid: 0, gid: 0, mode: 0o600 },
    { kind: 'file', uid: 0, gid: 0, mode: 0o666 },
    { kind: 'file', uid: 0, gid: 0, mode: 0o600, nlink: 2 },
  ]) {
    const values = fixture();
    values.put('/source.bin', 'file', { content });
    values.put('/protected/output.bin.devbridge-pending', state.kind, { ...state, content: 'partial' });
    await assert.rejects(() => transferLinuxProtectedFile(request(content), values.ports), /pending authority is invalid/u);
    assert.equal(values.calls.some(([name]) => ['unlink', 'rename'].includes(name)), false);
  }
});

test('streamed protected transfer handles partial reads and writes without widening memory', async () => {
  const values = fixture({ maximumRead: 3, maximumWrite: 2 });
  const content = Buffer.from('partial descriptor operations must complete');
  values.put('/source.bin', 'file', { content });
  const result = await transferLinuxProtectedFile(request(content), values.ports);
  assert.equal(result.digest, sha256(content));
  assert.deepEqual(values.entries.get('/protected/output.bin').content, content);
  assert.equal(values.calls.filter(([name]) => name === 'read').length > 2, true);
  assert.equal(values.calls.filter(([name]) => name === 'write').length > 2, true);
});

test('transfer contracts reject aliases, invalid bounds, and unknown interface fields', async () => {
  const content = Buffer.from('contract bytes');
  const values = fixture();
  values.put('/source.bin', 'file', { content });
  await assert.rejects(() => transferLinuxProtectedFile(request(content, {
    input: { path: '/protected/output.bin', size: content.length, digest: sha256(content) },
  }), values.ports), /paths must be distinct/u);
  await assert.rejects(() => transferLinuxProtectedFile(request(content, {
    input: { path: '/source.bin', size: 0, digest: sha256(content) },
  }), values.ports), /input size is invalid/u);
  await assert.rejects(() => transferLinuxProtectedFile(request(content, {
    input: { path: '/source.bin', size: content.length, digest: sha256(content), sourceName: 'coupled' },
  }), values.ports), /unknown field/u);
  await assert.rejects(() => transferLinuxProtectedFile(request(content, {
    output: { path: '/protected/output.bin', ownerId: 995, groupId: 994, mode: 0o440, targetName: 'coupled' },
  }), values.ports), /unknown field/u);
  assert.equal(values.calls.some(([name]) => ['write', 'rename', 'unlink'].includes(name)), false);
});

test('real Linux filesystem preserves descriptor-bound streamed transfer policy', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-protected-transfer-'));
  try {
    const protectedPath = path.join(root, 'protected');
    const inputPath = path.join(root, 'source.bin');
    const outputPath = path.join(protectedPath, 'output.bin');
    const content = Buffer.alloc(160 * 1024 + 17, 0x5a);
    await mkdir(protectedPath, { mode: 0o700 });
    await chmod(protectedPath, 0o700);
    await writeFile(inputPath, content);
    const parentInfo = await lstat(protectedPath);
    const result = await transferLinuxProtectedFile({
      input: { path: inputPath, size: content.length, digest: sha256(content) },
      output: { path: outputPath, ownerId: parentInfo.uid, groupId: parentInfo.gid, mode: 0o440 },
      parent: { path: protectedPath, ownerId: parentInfo.uid, groupId: parentInfo.gid, mode: 0o700 },
      creatorIds: { ownerId: parentInfo.uid, groupId: parentInfo.gid },
    });
    const outputInfo = await lstat(outputPath);
    assert.equal(result.changed, true);
    assert.equal(outputInfo.size, content.length);
    assert.equal(outputInfo.nlink, 1);
    assert.equal(outputInfo.mode & 0o7777, 0o440);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
