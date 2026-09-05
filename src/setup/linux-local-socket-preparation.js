import { lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PROTOCOL = 'devbridge/linux-local-socket-preparation-v1';

function absolute(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096 || /[\\\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value) {
    throw new TypeError(`${name} must be a normalized absolute Linux path`);
  }
  return value;
}

function numeric(value, name, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new TypeError(`${name} is invalid`);
  return value;
}

function permission(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o7777) throw new TypeError(`${name} is invalid`);
  return value;
}

function groups(value, name) {
  if (!Array.isArray(value) || value.length < 1) throw new TypeError(`${name} is invalid`);
  const selected = value.map((entry) => numeric(entry, name, { zero: true }));
  if (new Set(selected).size !== selected.length) throw new TypeError(`${name} is invalid`);
  return Object.freeze(selected);
}

function mode(info) {
  return info.mode & 0o7777;
}

async function optional(target, inspect) {
  try { return await inspect(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function prepareLinuxLocalSocket({
  endpoint,
  directoryOwnerId = process.getuid?.(),
  directoryGroupIds = [process.getgid?.()],
  directoryMode,
  socketOwnerId = process.getuid?.(),
  socketGroupId = process.getgid?.(),
  socketMode = 0o770,
} = {}, {
  inspect = lstat,
  remove = unlink,
} = {}) {
  const selectedEndpoint = absolute(endpoint, 'local socket endpoint');
  const parent = path.posix.dirname(selectedEndpoint);
  if (parent === '/' || parent === selectedEndpoint) throw new TypeError('local socket endpoint parent is invalid');
  const selectedDirectoryOwner = numeric(directoryOwnerId, 'local socket directory owner');
  const selectedDirectoryGroups = groups(directoryGroupIds, 'local socket directory groups');
  const selectedDirectoryMode = permission(directoryMode, 'local socket directory mode');
  const selectedSocketOwner = numeric(socketOwnerId, 'local socket owner');
  const selectedSocketGroup = socketGroupId == null ? null : numeric(socketGroupId, 'local socket group', { zero: true });
  const selectedSocketMode = permission(socketMode, 'local socket mode');
  if ((selectedDirectoryMode & 0o022) !== 0) throw new TypeError('local socket directory must not be writable by group or other');
  if (typeof inspect !== 'function' || typeof remove !== 'function') throw new TypeError('local socket preparation ports are invalid');

  const parentInfo = await inspect(parent);
  if (!parentInfo || parentInfo.isSymbolicLink() || !parentInfo.isDirectory()
      || parentInfo.uid !== selectedDirectoryOwner || !selectedDirectoryGroups.includes(parentInfo.gid)
      || mode(parentInfo) !== selectedDirectoryMode) {
    throw new Error('local socket directory authority is invalid');
  }
  const existing = await optional(selectedEndpoint, inspect);
  if (existing == null) return Object.freeze({ protocol: PROTOCOL, ready: true, changed: false, endpoint: selectedEndpoint });
  if (existing.isSymbolicLink() || !existing.isSocket()
      || existing.uid !== selectedSocketOwner || existing.gid !== (selectedSocketGroup ?? parentInfo.gid)
      || mode(existing) !== selectedSocketMode || existing.nlink !== 1) {
    throw new Error('local socket endpoint authority is invalid');
  }
  await remove(selectedEndpoint);
  if (await optional(selectedEndpoint, inspect) != null) throw new Error('local socket endpoint changed during reconciliation');
  return Object.freeze({ protocol: PROTOCOL, ready: true, changed: true, endpoint: selectedEndpoint });
}

export { PROTOCOL as LINUX_LOCAL_SOCKET_PREPARATION_PROTOCOL };
