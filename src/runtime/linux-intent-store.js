import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/activity-intent-v1';
const MODE = 0o640;
const MAX_BYTES = 512;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const DEFAULT_OPEN_FLAGS = Object.freeze({
  O_RDONLY: constants.O_RDONLY,
  O_WRONLY: constants.O_WRONLY,
  O_CREAT: constants.O_CREAT,
  O_EXCL: constants.O_EXCL,
  O_NOFOLLOW: constants.O_NOFOLLOW,
});

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)
    || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value || value === '/') {
    throw new TypeError(`${name} must be a normalized absolute Linux path`);
  }
  return value;
}

function identifier(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function accessMode(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o7777) throw new TypeError(`${name} is invalid`);
  return value;
}

function intent(value) {
  const selected = exactObject(value, new Set(['subject', 'operationId']), 'Linux intent');
  if (typeof selected.subject !== 'string' || !SAFE_VALUE.test(selected.subject)) throw new TypeError('Linux intent subject is invalid');
  if (typeof selected.operationId !== 'string' || !SAFE_VALUE.test(selected.operationId)) throw new TypeError('Linux intent operationId is invalid');
  return Object.freeze({ subject: selected.subject, operationId: selected.operationId });
}

function canonical(value) {
  return Buffer.from(`${JSON.stringify({ protocol: PROTOCOL, subject: value.subject, operationId: value.operationId })}\n`, 'utf8');
}

function parse(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_BYTES || bytes.at(-1) !== 0x0a) {
    throw new Error('Linux intent content is invalid');
  }
  let raw;
  try { raw = JSON.parse(bytes.subarray(0, -1).toString('utf8')); }
  catch { throw new Error('Linux intent content is invalid'); }
  const selected = exactObject(raw, new Set(['protocol', 'subject', 'operationId']), 'Linux intent content');
  if (selected.protocol !== PROTOCOL) throw new Error('Linux intent protocol is invalid');
  const result = intent({ subject: selected.subject, operationId: selected.operationId });
  if (!bytes.equals(canonical(result))) throw new Error('Linux intent content is not canonical');
  return result;
}

function mode(info) {
  return info.mode & 0o7777;
}

function entryEvidence(info, expected) {
  return info != null
    && !info.isSymbolicLink()
    && info.isFile()
    && info.uid === expected.ownerId
    && info.gid === expected.groupId
    && mode(info) === MODE
    && info.nlink === 1
    && info.size >= 1
    && info.size <= MAX_BYTES;
}

function directoryEvidence(info, expected) {
  return info != null
    && !info.isSymbolicLink()
    && info.isDirectory()
    && info.uid === expected.ownerId
    && info.gid === expected.groupId
    && mode(info) === expected.mode;
}

function sameEntry(left, right) {
  return left != null && right != null && left.dev === right.dev && left.ino === right.ino;
}

function stableEntry(left, right) {
  return sameEntry(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function optionalStat(target, stat) {
  try { return await stat(target); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function flags(value) {
  const selected = exactObject(value, new Set(['O_RDONLY', 'O_WRONLY', 'O_CREAT', 'O_EXCL', 'O_NOFOLLOW']), 'Linux intent open flags');
  for (const name of Object.keys(selected)) {
    if (!Number.isSafeInteger(selected[name]) || selected[name] < 0 || (name !== 'O_RDONLY' && selected[name] === 0)) {
      throw new Error(`Linux intent ${name} flag is unavailable`);
    }
  }
  return Object.freeze({ ...selected });
}

function ports(value) {
  const selected = exactObject(value, new Set(['stat', 'openFile', 'removeFile', 'syncDirectory', 'openFlags']), 'Linux intent ports');
  for (const name of ['stat', 'openFile', 'removeFile', 'syncDirectory']) {
    if (typeof selected[name] !== 'function') throw new TypeError(`Linux intent ${name} port is invalid`);
  }
  return Object.freeze({ ...selected, openFlags: flags(selected.openFlags) });
}

async function close(handle) {
  if (handle != null) await handle.close();
}

async function readExactly(handle, size) {
  const result = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const next = await handle.read(result, offset, size - offset, offset);
    if (!next || !Number.isSafeInteger(next.bytesRead) || next.bytesRead < 1 || next.bytesRead > size - offset) {
      throw new Error('Linux intent content ended unexpectedly');
    }
    offset += next.bytesRead;
  }
  return result;
}

async function writeExactly(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const next = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (!next || !Number.isSafeInteger(next.bytesWritten) || next.bytesWritten < 1 || next.bytesWritten > bytes.length - offset) {
      throw new Error('Linux intent publication stopped accepting bytes');
    }
    offset += next.bytesWritten;
  }
}

async function defaultSyncDirectory(target) {
  const handle = await open(target, constants.O_RDONLY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function requireDirectory(selected, adapter) {
  const info = await optionalStat(selected.directory.path, adapter.stat);
  if (!directoryEvidence(info, selected.directory)) throw new Error('Linux intent directory policy is invalid');
  return info;
}

async function observe(selected, adapter) {
  const parentBefore = await requireDirectory(selected, adapter);
  const pathBefore = await optionalStat(selected.recordPath, adapter.stat);
  if (pathBefore == null) {
    const parentAfter = await requireDirectory(selected, adapter);
    if (!sameEntry(parentBefore, parentAfter)) throw new Error('Linux intent directory changed during absence observation');
    return null;
  }
  if (!entryEvidence(pathBefore, selected)) throw new Error('Linux intent record policy is invalid');
  let handle;
  let handleBefore;
  let handleAfter;
  let result;
  try {
    handle = await adapter.openFile(selected.recordPath, adapter.openFlags.O_RDONLY);
    handleBefore = await handle.stat();
    if (!entryEvidence(handleBefore, selected) || !sameEntry(pathBefore, handleBefore)) {
      throw new Error('Linux intent record descriptor policy is invalid');
    }
    result = parse(await readExactly(handle, handleBefore.size));
    handleAfter = await handle.stat();
    if (!entryEvidence(handleAfter, selected) || !stableEntry(handleBefore, handleAfter)) {
      throw new Error('Linux intent record changed while open');
    }
  } finally {
    await close(handle);
  }
  const pathAfter = await optionalStat(selected.recordPath, adapter.stat);
  const parentAfter = await requireDirectory(selected, adapter);
  if (!entryEvidence(pathAfter, selected) || !stableEntry(handleAfter, pathAfter)
    || !sameEntry(parentBefore, parentAfter)) {
    throw new Error('Linux intent record or directory changed during observation');
  }
  return result;
}

export function createLinuxIntentStore(raw = {}, dependencies = {}) {
  const input = exactObject(raw, new Set(['directory', 'recordPath', 'ownerId', 'groupId']), 'Linux intent configuration');
  const directory = exactObject(input.directory, new Set(['path', 'ownerId', 'groupId', 'mode']), 'Linux intent directory');
  const selected = Object.freeze({
    directory: Object.freeze({
      path: absolutePath(directory.path, 'Linux intent directory path'),
      ownerId: identifier(directory.ownerId, 'Linux intent directory owner'),
      groupId: identifier(directory.groupId, 'Linux intent directory group'),
      mode: accessMode(directory.mode, 'Linux intent directory mode'),
    }),
    recordPath: absolutePath(input.recordPath, 'Linux intent record path'),
    ownerId: identifier(input.ownerId, 'Linux intent owner'),
    groupId: identifier(input.groupId, 'Linux intent group'),
  });
  if (path.posix.dirname(selected.recordPath) !== selected.directory.path) {
    throw new Error('Linux intent record is not an immediate child of its directory');
  }
  const injected = exactObject(dependencies, new Set(['stat', 'openFile', 'removeFile', 'syncDirectory', 'openFlags']), 'Linux intent dependencies');
  const adapter = ports({
    stat: injected.stat ?? lstat,
    openFile: injected.openFile ?? open,
    removeFile: injected.removeFile ?? unlink,
    syncDirectory: injected.syncDirectory ?? defaultSyncDirectory,
    openFlags: injected.openFlags ?? DEFAULT_OPEN_FLAGS,
  });

  return Object.freeze({
    async observe() {
      return observe(selected, adapter);
    },
    async ensure(rawIntent) {
      const expected = intent(rawIntent);
      const existing = await observe(selected, adapter);
      if (existing != null) {
        if (existing.subject !== expected.subject || existing.operationId !== expected.operationId) {
          throw new Error('Linux intent record belongs to another operation');
        }
        return existing;
      }
      const parentBefore = await requireDirectory(selected, adapter);
      const bytes = canonical(expected);
      let handle;
      try {
        const creationFlags = adapter.openFlags.O_WRONLY | adapter.openFlags.O_CREAT | adapter.openFlags.O_EXCL | adapter.openFlags.O_NOFOLLOW;
        handle = await adapter.openFile(selected.recordPath, creationFlags, MODE);
        await handle.chmod(MODE);
        await writeExactly(handle, bytes);
        await handle.sync();
        const info = await handle.stat();
        if (!entryEvidence(info, selected) || info.size !== bytes.length) {
          throw new Error('Linux intent published descriptor policy is invalid');
        }
      } catch (error) {
        if (error?.code === 'EEXIST') {
          const raced = await observe(selected, adapter);
          if (raced != null && raced.subject === expected.subject && raced.operationId === expected.operationId) return raced;
          throw new Error('Linux intent record publication conflicted');
        }
        throw error;
      } finally {
        await close(handle);
      }
      await adapter.syncDirectory(selected.directory.path);
      const parentAfter = await requireDirectory(selected, adapter);
      if (!sameEntry(parentBefore, parentAfter)) throw new Error('Linux intent directory changed during publication');
      const published = await observe(selected, adapter);
      if (published == null || published.subject !== expected.subject || published.operationId !== expected.operationId) {
        throw new Error('Linux intent publication did not reach exact readiness');
      }
      return published;
    },
    async clear(rawIntent) {
      const expected = intent(rawIntent);
      const observed = await observe(selected, adapter);
      if (observed == null) return false;
      if (observed.subject !== expected.subject || observed.operationId !== expected.operationId) {
        throw new Error('Linux intent record cannot be cleared by another operation');
      }
      const parentBefore = await requireDirectory(selected, adapter);
      const entryBefore = await optionalStat(selected.recordPath, adapter.stat);
      if (!entryEvidence(entryBefore, selected)) throw new Error('Linux intent record changed before clearing');
      await adapter.removeFile(selected.recordPath);
      await adapter.syncDirectory(selected.directory.path);
      const entryAfter = await optionalStat(selected.recordPath, adapter.stat);
      const parentAfter = await requireDirectory(selected, adapter);
      if (entryAfter != null || !sameEntry(parentBefore, parentAfter)) {
        throw new Error('Linux intent record clearing is ambiguous');
      }
      return true;
    },
  });
}

export const LINUX_INTENT_PROTOCOL = PROTOCOL;
