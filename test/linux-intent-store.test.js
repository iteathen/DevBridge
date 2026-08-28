import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLinuxIntentStore, LINUX_INTENT_PROTOCOL } from '../src/runtime/linux-intent-store.js';

const FLAGS = Object.freeze({ O_RDONLY: 0, O_WRONLY: 1, O_CREAT: 2, O_EXCL: 4, O_NOFOLLOW: 8 });
const DIRECTORY = Object.freeze({ path: '/run/devbridge/test/governance', ownerId: 0, groupId: 993, mode: 0o3770 });
const RECORD = `${DIRECTORY.path}/shared.intent`;
const INTENT = Object.freeze({ subject: 'subject-1', operationId: 'operation-1' });

function info({ kind, uid, gid, mode, size = 0, ino, symlink = false, nlink = 1, mtimeMs = 1, ctimeMs = 1 }) {
  return Object.freeze({
    dev: 7, ino, uid, gid, mode, size, nlink, mtimeMs, ctimeMs,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => symlink,
  });
}

function fixture({ record = null, recordPolicy = {}, directoryPolicy = {}, mutateWhileOpen = false } = {}) {
  const state = {
    directory: { uid: 0, gid: 993, mode: 0o3770, ino: 10, ...directoryPolicy },
    record: record == null ? null : {
      bytes: Buffer.from(record), uid: 995, gid: 993, mode: 0o640, ino: 11, symlink: false, nlink: 1, version: 1, ...recordPolicy,
    },
  };
  const calls = [];
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const stat = async (target) => {
    calls.push(['stat', target]);
    if (target === DIRECTORY.path) return info({ kind: 'directory', ...state.directory });
    if (target !== RECORD || state.record == null) throw missing();
    const selected = state.record;
    return info({ kind: 'file', ...selected, size: selected.bytes.length, mtimeMs: selected.version, ctimeMs: selected.version });
  };
  const openFile = async (target, flags, mode) => {
    calls.push(['open', target, flags, mode]);
    if (target !== RECORD) throw new Error('foreign path');
    if ((flags & FLAGS.O_CREAT) !== 0) {
      if (state.record != null) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      state.record = { bytes: Buffer.alloc(0), uid: 995, gid: 993, mode, ino: 11, symlink: false, nlink: 1, version: 1 };
    } else if (state.record == null) throw missing();
    const openedIno = state.record.ino;
    let stats = 0;
    return {
      async chmod(value) { calls.push(['chmod', value]); state.record.mode = value; },
      async write(bytes, offset, length, position) {
        calls.push(['write', length, position]);
        const before = state.record.bytes;
        const required = Math.max(before.length, position + length);
        const next = Buffer.alloc(required);
        before.copy(next);
        Buffer.from(bytes).copy(next, position, offset, offset + length);
        state.record.bytes = next;
        return { bytesWritten: length };
      },
      async read(buffer, offset, length, position) {
        calls.push(['read', length, position]);
        const available = Math.min(length, state.record.bytes.length - position);
        state.record.bytes.copy(buffer, offset, position, position + available);
        return { bytesRead: available };
      },
      async sync() { calls.push(['sync-file']); },
      async stat() {
        stats += 1;
        const selected = state.record;
        const ino = mutateWhileOpen && stats > 1 ? openedIno + 1 : openedIno;
        return info({ kind: 'file', ...selected, ino, size: selected.bytes.length, mtimeMs: selected.version, ctimeMs: selected.version });
      },
      async close() { calls.push(['close']); },
    };
  };
  const dependencies = {
    stat,
    openFile,
    async removeFile(target) { calls.push(['remove', target]); state.record = null; },
    async syncDirectory(target) { calls.push(['sync-directory', target]); },
    openFlags: FLAGS,
  };
  const store = createLinuxIntentStore({ directory: DIRECTORY, recordPath: RECORD, ownerId: 995, groupId: 993 }, dependencies);
  return { state, calls, dependencies, store };
}

function canonical(value = INTENT) {
  return `${JSON.stringify({ protocol: LINUX_INTENT_PROTOCOL, subject: value.subject, operationId: value.operationId })}\n`;
}

test('new intent is exclusively published, synced, and re-observed exactly', async () => {
  const values = fixture();
  assert.deepEqual(await values.store.ensure(INTENT), INTENT);
  assert.equal(values.state.record.bytes.toString('utf8'), canonical());
  assert.equal(values.state.record.mode, 0o640);
  assert.equal(values.calls.some(([name, , flags]) => name === 'open' && (flags & FLAGS.O_EXCL) !== 0), true);
  assert.equal(values.calls.filter(([name]) => name === 'sync-directory').length, 1);
  assert.deepEqual(await values.store.observe(), INTENT);
});

test('exact existing intent is idempotent and foreign identity is never overwritten', async () => {
  const exact = fixture({ record: canonical() });
  assert.deepEqual(await exact.store.ensure(INTENT), INTENT);
  assert.equal(exact.calls.some(([name, , flags]) => name === 'open' && (flags & FLAGS.O_CREAT) !== 0), false);

  const foreignIntent = Object.freeze({ subject: 'subject-2', operationId: 'operation-2' });
  const foreign = fixture({ record: canonical(foreignIntent) });
  await assert.rejects(() => foreign.store.ensure(INTENT), /another operation/u);
  assert.equal(foreign.state.record.bytes.toString('utf8'), canonical(foreignIntent));
});

test('exact clearing refuses foreign records and proves absence after directory sync', async () => {
  const values = fixture({ record: canonical() });
  assert.equal(await values.store.clear(INTENT), true);
  assert.equal(values.state.record, null);
  assert.deepEqual(values.calls.filter(([name]) => ['remove', 'sync-directory'].includes(name)).map(([name]) => name), ['remove', 'sync-directory']);
  assert.equal(await values.store.clear(INTENT), false);

  const foreignIntent = Object.freeze({ subject: 'subject-2', operationId: 'operation-2' });
  const foreign = fixture({ record: canonical(foreignIntent) });
  await assert.rejects(() => foreign.store.clear(INTENT), /another operation/u);
  assert.notEqual(foreign.state.record, null);
});

test('malformed, noncanonical, symlinked, linked, and wrong-policy records fail closed', async () => {
  const variants = [
    fixture({ record: '{bad}\n' }),
    fixture({ record: `${JSON.stringify({ operationId: INTENT.operationId, subject: INTENT.subject, protocol: LINUX_INTENT_PROTOCOL })}\n` }),
    fixture({ record: canonical(), recordPolicy: { symlink: true } }),
    fixture({ record: canonical(), recordPolicy: { nlink: 2 } }),
    fixture({ record: canonical(), recordPolicy: { uid: 1000 } }),
    fixture({ record: canonical(), recordPolicy: { mode: 0o666 } }),
    fixture({ record: canonical(), directoryPolicy: { mode: 0o777 } }),
  ];
  for (const values of variants) await assert.rejects(() => values.store.observe(), /Linux intent/u);
});

test('descriptor substitution or mutation during observation is rejected', async () => {
  const values = fixture({ record: canonical(), mutateWhileOpen: true });
  await assert.rejects(() => values.store.observe(), /changed while open/u);
});

test('configuration, dependency, and record widening are rejected', async () => {
  assert.throws(() => createLinuxIntentStore({ directory: DIRECTORY, recordPath: '/foreign', ownerId: 995, groupId: 993 }, {
    stat: async () => {}, openFile: async () => {}, removeFile: async () => {}, syncDirectory: async () => {}, openFlags: FLAGS,
  }), /immediate child/u);
  assert.throws(() => createLinuxIntentStore({ directory: DIRECTORY, recordPath: RECORD, ownerId: 995, groupId: 993, command: 'foreign' }), /unknown field/u);
  assert.throws(() => createLinuxIntentStore({ directory: DIRECTORY, recordPath: RECORD, ownerId: 995, groupId: 993 }, { extra: true }), /unknown field/u);
  const values = fixture();
  await assert.rejects(() => values.store.ensure({ ...INTENT, path: '/foreign' }), /unknown field/u);
});

test('real Linux filesystem canary proves exact publication and clearing', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-intent-'));
  try {
    await chmod(root, 0o770);
    const selected = { path: root, ownerId: process.getuid(), groupId: process.getgid(), mode: 0o770 };
    const store = createLinuxIntentStore({
      directory: selected,
      recordPath: path.join(root, 'activity.intent'),
      ownerId: process.getuid(),
      groupId: process.getgid(),
    });
    assert.deepEqual(await store.ensure(INTENT), INTENT);
    assert.deepEqual(await store.observe(), INTENT);
    assert.equal(await store.clear(INTENT), true);
    assert.equal(await store.observe(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
