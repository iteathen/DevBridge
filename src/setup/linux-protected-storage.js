import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/linux-protected-storage-v1';
const MAX_CONTENT_BYTES = 1024 * 1024;

async function syncLinuxDirectory(target) {
  const handle = await open(target, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value) || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value || value === '/') {
    throw new TypeError(`${name} must be a normalized absolute Linux path`);
  }
  return value;
}

function identifier(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function accessMode(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o7777) throw new TypeError(`${name} is invalid`);
  return value;
}

function bytes(value, maximumBytes) {
  const content = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8');
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_CONTENT_BYTES || content.length < 1 || content.length > maximumBytes) {
    throw new TypeError('Linux protected file content is outside its bound');
  }
  return content;
}

function mode(info) {
  return info.mode & 0o7777;
}

function realKind(info, kind) {
  if (info == null || info.isSymbolicLink()) return false;
  if (kind === 'directory') return info.isDirectory();
  if (kind === 'file') return info.isFile();
  return false;
}

async function optionalStat(target, stat) {
  try { return await stat(target); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function normalizeContract(value, name, { kind }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  const allowed = new Set(['path', 'ownerId', 'groupId', 'mode']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return Object.freeze({
    path: absolutePath(value.path, `${name} path`),
    ownerId: identifier(value.ownerId, `${name} owner`),
    groupId: identifier(value.groupId, `${name} group`),
    mode: accessMode(value.mode, `${name} mode`, { nullable: kind === 'parent' }),
  });
}

function evidence(info, contract, kind) {
  return Object.freeze({
    exists: info != null,
    kind: realKind(info, kind),
    owner: info?.uid === contract.ownerId,
    group: info?.gid === contract.groupId,
    mode: info == null ? false : contract.mode == null ? (mode(info) & 0o022) === 0 : mode(info) === contract.mode,
    observedMode: info == null ? null : mode(info),
  });
}

function ready(value) {
  return value.exists && value.kind && value.owner && value.group && value.mode;
}

async function requireParent(target, parent, stat) {
  const selected = normalizeContract(parent, 'Linux protected parent', { kind: 'parent' });
  if (path.posix.dirname(target) !== selected.path) throw new Error('Linux protected target is not an immediate child of its declared parent');
  const observed = evidence(await optionalStat(selected.path, stat), selected, 'directory');
  if (!ready(observed)) throw new Error('Linux protected parent authority is invalid');
  return selected;
}

function requirePorts(ports, names) {
  for (const name of names) if (typeof ports[name] !== 'function') throw new TypeError(`Linux protected storage ${name} port is invalid`);
  return ports;
}

export async function inspectLinuxProtectedEntry({ contract, kind } = {}, {
  stat = lstat,
} = {}) {
  if (!['directory', 'file'].includes(kind)) throw new TypeError('Linux protected entry kind is invalid');
  if (typeof stat !== 'function') throw new TypeError('Linux protected storage stat port is invalid');
  const selected = normalizeContract(contract, 'Linux protected entry', { kind });
  return Object.freeze({ protocol: PROTOCOL, path: selected.path, kind, ...evidence(await optionalStat(selected.path, stat), selected, kind) });
}

export async function ensureLinuxProtectedDirectory({
  contract,
  parent,
  adoptOwnerIds = [],
  adoptGroupIds = [],
} = {}, {
  stat = lstat,
  makeDirectory = mkdir,
  setOwner = chown,
  setMode = chmod,
  syncDirectory = syncLinuxDirectory,
} = {}) {
  const ports = requirePorts({ stat, makeDirectory, setOwner, setMode, syncDirectory }, ['stat', 'makeDirectory', 'setOwner', 'setMode', 'syncDirectory']);
  const selected = normalizeContract(contract, 'Linux protected directory', { kind: 'directory' });
  const selectedParent = await requireParent(selected.path, parent, ports.stat);
  const allowedOwners = new Set(adoptOwnerIds.map((value) => identifier(value, 'Linux protected adopt owner')));
  const allowedGroups = new Set(adoptGroupIds.map((value) => identifier(value, 'Linux protected adopt group')));
  let info = await optionalStat(selected.path, ports.stat);
  let changed = false;
  if (info == null) {
    await ports.makeDirectory(selected.path, { recursive: false, mode: 0o700 });
    changed = true;
    info = await optionalStat(selected.path, ports.stat);
  }
  if (!realKind(info, 'directory')) throw new Error('Linux protected directory is not a real directory');
  if (info.uid !== selected.ownerId || info.gid !== selected.groupId) {
    if ((info.uid !== selected.ownerId && !allowedOwners.has(info.uid))
        || (info.gid !== selected.groupId && !allowedGroups.has(info.gid))) {
      throw new Error('Linux protected directory ownership is foreign');
    }
    await ports.setOwner(selected.path, selected.ownerId, selected.groupId);
    changed = true;
    info = await optionalStat(selected.path, ports.stat);
  }
  if (mode(info) !== selected.mode) {
    await ports.setMode(selected.path, selected.mode);
    changed = true;
  }
  if (changed) await ports.syncDirectory(selectedParent.path);
  const observed = await inspectLinuxProtectedEntry({ contract: selected, kind: 'directory' }, { stat: ports.stat });
  if (!ready(observed)) throw new Error('Linux protected directory mutation is not observable');
  return Object.freeze({ ...observed, changed });
}

export async function readLinuxProtectedFile({ contract, maximumBytes = MAX_CONTENT_BYTES } = {}, {
  stat = lstat,
  load = readFile,
} = {}) {
  const ports = requirePorts({ stat, load }, ['stat', 'load']);
  const selected = normalizeContract(contract, 'Linux protected file', { kind: 'file' });
  const info = await optionalStat(selected.path, ports.stat);
  const observed = evidence(info, selected, 'file');
  if (!ready(observed) || info.size < 1 || info.size > maximumBytes) throw new Error('Linux protected file evidence is invalid');
  const content = Buffer.from(await ports.load(selected.path));
  if (content.length !== info.size || content.length > maximumBytes) throw new Error('Linux protected file changed while being read');
  const after = await optionalStat(selected.path, ports.stat);
  if (!realKind(after, 'file') || after.uid !== info.uid || after.gid !== info.gid || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
    throw new Error('Linux protected file changed while being read');
  }
  return Object.freeze({ protocol: PROTOCOL, content, size: content.length });
}

export async function writeLinuxProtectedFile({
  contract,
  parent,
  content,
  maximumBytes = MAX_CONTENT_BYTES,
} = {}, {
  stat = lstat,
  load = readFile,
  save = writeFile,
  setOwner = chown,
  setMode = chmod,
  move = rename,
  remove = unlink,
  syncDirectory = syncLinuxDirectory,
} = {}) {
  const ports = requirePorts({ stat, load, save, setOwner, setMode, move, remove, syncDirectory }, ['stat', 'load', 'save', 'setOwner', 'setMode', 'move', 'remove', 'syncDirectory']);
  const selected = normalizeContract(contract, 'Linux protected file', { kind: 'file' });
  const expected = bytes(content, maximumBytes);
  const selectedParent = await requireParent(selected.path, parent, ports.stat);
  const current = await optionalStat(selected.path, ports.stat);
  if (current != null) {
    if (!realKind(current, 'file') || current.uid !== selected.ownerId || current.gid !== selected.groupId) {
      throw new Error('Linux protected file ownership is foreign');
    }
    if (current.size > maximumBytes) throw new Error('Linux protected file exceeds its bound');
    const currentBytes = mode(current) === selected.mode
      ? (await readLinuxProtectedFile({ contract: selected, maximumBytes }, { stat: ports.stat, load: ports.load })).content
      : null;
    if (currentBytes?.equals(expected)) {
      return Object.freeze({ protocol: PROTOCOL, path: selected.path, kind: 'file', ...evidence(current, selected, 'file'), changed: false });
    }
  }

  const pendingPath = `${selected.path}.devbridge-pending`;
  const pending = await optionalStat(pendingPath, ports.stat);
  if (pending != null) {
    if (!realKind(pending, 'file') || pending.uid !== selected.ownerId || pending.gid !== selected.groupId) {
      throw new Error('Linux protected pending file is foreign');
    }
    await ports.remove(pendingPath);
    await ports.syncDirectory(selectedParent.path);
  }
  await ports.save(pendingPath, expected, { flag: 'wx', mode: 0o600, flush: true });
  let written = await optionalStat(pendingPath, ports.stat);
  if (!realKind(written, 'file') || written.size !== expected.length) throw new Error('Linux protected pending file is not observable');
  if (written.uid !== selected.ownerId || written.gid !== selected.groupId) {
    if (written.uid !== 0 || written.gid !== 0) throw new Error('Linux protected pending file ownership is foreign');
    await ports.setOwner(pendingPath, selected.ownerId, selected.groupId);
    written = await optionalStat(pendingPath, ports.stat);
  }
  if (mode(written) !== selected.mode) await ports.setMode(pendingPath, selected.mode);
  const pendingContract = Object.freeze({ ...selected, path: pendingPath });
  const pendingEvidence = await inspectLinuxProtectedEntry({ contract: pendingContract, kind: 'file' }, { stat: ports.stat });
  if (!ready(pendingEvidence)) throw new Error('Linux protected pending file policy is invalid');
  const staged = Buffer.from(await ports.load(pendingPath));
  if (!staged.equals(expected)) throw new Error('Linux protected pending file bytes changed');
  await ports.move(pendingPath, selected.path);
  await ports.syncDirectory(selectedParent.path);
  const observed = await inspectLinuxProtectedEntry({ contract: selected, kind: 'file' }, { stat: ports.stat });
  if (!ready(observed)) throw new Error('Linux protected file replacement is not observable');
  const installed = Buffer.from(await ports.load(selected.path));
  if (!installed.equals(expected)) throw new Error('Linux protected file replacement bytes changed');
  return Object.freeze({ ...observed, changed: true });
}

export { PROTOCOL as LINUX_PROTECTED_STORAGE_PROTOCOL };
