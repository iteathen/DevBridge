import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
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
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/u;

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

function digest(value, name) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function positive(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
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

function openFlag(flags, name, { zero = false } = {}) {
  const value = flags?.[name];
  if (!Number.isSafeInteger(value) || value < 0 || (!zero && value === 0)) throw new Error(`Linux protected transfer ${name} is unavailable`);
  return value;
}

function stableFile(before, after) {
  return after.isFile()
    && !after.isSymbolicLink()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function sameFile(before, after) {
  return before != null
    && after != null
    && before.dev === after.dev
    && before.ino === after.ino;
}

async function readHandle(handle, { size, maximumBytes, requireSingleLink, onChunk = null }) {
  const before = await handle.stat();
  if (!before.isFile() || before.isSymbolicLink() || before.size !== size || before.size < 1 || before.size > maximumBytes || (requireSingleLink && before.nlink !== 1)) {
    throw new Error('Linux protected transfer file evidence is invalid');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const result = await handle.read(buffer, 0, length, position);
    if (!result || !Number.isSafeInteger(result.bytesRead) || result.bytesRead < 1 || result.bytesRead > length) {
      throw new Error('Linux protected transfer input ended unexpectedly');
    }
    const chunk = buffer.subarray(0, result.bytesRead);
    hash.update(chunk);
    if (onChunk != null) await onChunk(chunk, position);
    position += result.bytesRead;
  }
  const after = await handle.stat();
  if (!stableFile(before, after)) throw new Error('Linux protected transfer file changed while open');
  return Object.freeze({ size: position, digest: hash.digest('hex'), info: after });
}

async function writeHandle(handle, chunk, position) {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset, position + offset);
    if (!result || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1 || result.bytesWritten > chunk.length - offset) {
      throw new Error('Linux protected transfer output stopped accepting bytes');
    }
    offset += result.bytesWritten;
  }
}

function transferInput(value, maximumBytes) {
  exactKeys(value, new Set(['path', 'size', 'digest']), 'Linux protected transfer input');
  return Object.freeze({
    path: absolutePath(value.path, 'Linux protected transfer input path'),
    size: positive(value.size, 'Linux protected transfer input size', maximumBytes),
    digest: digest(value.digest, 'Linux protected transfer input digest'),
  });
}

function creator(value) {
  exactKeys(value, new Set(['ownerId', 'groupId']), 'Linux protected transfer creator');
  return Object.freeze({
    ownerId: identifier(value.ownerId, 'Linux protected transfer creator owner'),
    groupId: identifier(value.groupId, 'Linux protected transfer creator group'),
  });
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

async function closeHandle(handle) {
  if (handle != null) await handle.close();
}

function requireTransferredPolicy(info, { ownerId, groupId, mode: expectedMode, size }, message) {
  if (!realKind(info, 'file') || info.uid !== ownerId || info.gid !== groupId || mode(info) !== expectedMode || info.nlink !== 1 || info.size !== size) {
    throw new Error(message);
  }
}

async function measureTransferredFile({ path: target, ownerId, groupId, mode: expectedMode, size, maximumBytes }, ports, readFlags) {
  const info = await optionalStat(target, ports.stat);
  requireTransferredPolicy(info, { ownerId, groupId, mode: expectedMode, size }, 'Linux protected transferred file policy is invalid');
  let handle;
  let observed;
  try {
    handle = await ports.openFile(target, readFlags);
    observed = await readHandle(handle, { size, maximumBytes, requireSingleLink: true });
    requireTransferredPolicy(observed.info, { ownerId, groupId, mode: expectedMode, size }, 'Linux protected transferred file descriptor policy is invalid');
  } finally {
    await closeHandle(handle);
  }
  const after = await optionalStat(target, ports.stat);
  requireTransferredPolicy(after, { ownerId, groupId, mode: expectedMode, size }, 'Linux protected transferred file policy changed');
  if (!sameFile(observed.info, after) || !stableFile(observed.info, after)) throw new Error('Linux protected transferred file path changed');
  return observed;
}

async function verifyTransferredFile(contract, ports, readFlags) {
  const observed = await measureTransferredFile(contract, ports, readFlags);
  if (observed.digest !== contract.expectedDigest) throw new Error('Linux protected transferred file digest is invalid');
  return observed;
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

export async function transferLinuxProtectedFile({
  input,
  output,
  parent,
  creatorIds = Object.freeze({ ownerId: 0, groupId: 0 }),
  maximumBytes = MAX_TRANSFER_BYTES,
} = {}, {
  stat = lstat,
  openFile = open,
  move = rename,
  remove = unlink,
  syncDirectory = syncLinuxDirectory,
  openFlags = constants,
} = {}) {
  const ports = requirePorts({ stat, openFile, move, remove, syncDirectory }, ['stat', 'openFile', 'move', 'remove', 'syncDirectory']);
  const selectedMaximum = positive(maximumBytes, 'Linux protected transfer maximum', MAX_TRANSFER_BYTES);
  const selectedInput = transferInput(input, selectedMaximum);
  const selectedOutput = normalizeContract(output, 'Linux protected transfer output', { kind: 'file' });
  const selectedCreator = creator(creatorIds);
  const selectedParent = await requireParent(selectedOutput.path, parent, ports.stat);
  const pendingPath = `${selectedOutput.path}.devbridge-pending`;
  if (new Set([selectedInput.path, selectedOutput.path, pendingPath]).size !== 3) {
    throw new Error('Linux protected transfer paths must be distinct');
  }
  const readFlags = openFlag(openFlags, 'O_RDONLY', { zero: true }) | openFlag(openFlags, 'O_NOFOLLOW');
  const writeFlags = openFlag(openFlags, 'O_WRONLY')
    | openFlag(openFlags, 'O_CREAT')
    | openFlag(openFlags, 'O_EXCL')
    | openFlag(openFlags, 'O_NOFOLLOW');

  const current = await optionalStat(selectedOutput.path, ports.stat);
  if (current != null) {
    if (!realKind(current, 'file') || current.uid !== selectedOutput.ownerId || current.gid !== selectedOutput.groupId || current.nlink !== 1) {
      throw new Error('Linux protected transfer output authority is invalid');
    }
    if (current.size > selectedMaximum) throw new Error('Linux protected transfer output exceeds its bound');
    if (mode(current) === selectedOutput.mode && current.size === selectedInput.size) {
      const observed = await measureTransferredFile({
        ...selectedOutput,
        size: selectedInput.size,
        maximumBytes: selectedMaximum,
      }, ports, readFlags);
      if (observed.digest === selectedInput.digest) {
        await ports.syncDirectory(selectedParent.path);
        return Object.freeze({
          protocol: PROTOCOL,
          path: selectedOutput.path,
          kind: 'file',
          size: observed.size,
          digest: observed.digest,
          changed: false,
        });
      }
    }
  }

  let inputHandle;
  try {
    inputHandle = await ports.openFile(selectedInput.path, readFlags);
    const inputInfo = await inputHandle.stat();
    if (!realKind(inputInfo, 'file') || inputInfo.size !== selectedInput.size || inputInfo.size < 1 || inputInfo.size > selectedMaximum) {
      throw new Error('Linux protected transfer input evidence is invalid');
    }

    const pending = await optionalStat(pendingPath, ports.stat);
    if (pending != null) {
      const creatorState = pending.uid === selectedCreator.ownerId
        && pending.gid === selectedCreator.groupId
        && mode(pending) === 0o600;
      const outputState = pending.uid === selectedOutput.ownerId
        && pending.gid === selectedOutput.groupId
        && [0o600, selectedOutput.mode].includes(mode(pending));
      if (!realKind(pending, 'file') || pending.nlink !== 1 || pending.size > selectedMaximum || (!creatorState && !outputState)) {
        throw new Error('Linux protected transfer pending authority is invalid');
      }
      await ports.remove(pendingPath);
      await ports.syncDirectory(selectedParent.path);
    }

    let outputHandle;
    try {
      outputHandle = await ports.openFile(pendingPath, writeFlags, 0o600);
      for (const name of ['stat', 'write', 'chown', 'chmod', 'sync', 'close']) {
        if (typeof outputHandle?.[name] !== 'function') throw new TypeError(`Linux protected transfer output ${name} operation is invalid`);
      }
      const created = await outputHandle.stat();
      if (!realKind(created, 'file') || created.nlink !== 1 || created.size !== 0
          || created.uid !== selectedCreator.ownerId || created.gid !== selectedCreator.groupId
          || (mode(created) & ~0o600) !== 0) {
        throw new Error('Linux protected transfer created file authority is invalid');
      }
      const observedInput = await readHandle(inputHandle, {
        size: selectedInput.size,
        maximumBytes: selectedMaximum,
        requireSingleLink: false,
        onChunk: (chunk, position) => writeHandle(outputHandle, chunk, position),
      });
      if (!sameFile(inputInfo, observedInput.info) || !stableFile(inputInfo, observedInput.info)) {
        throw new Error('Linux protected transfer input changed after admission');
      }
      if (observedInput.digest !== selectedInput.digest) throw new Error('Linux protected transfer input digest is invalid');

      let written = await outputHandle.stat();
      if (!sameFile(created, written) || !realKind(written, 'file') || written.nlink !== 1 || written.size !== selectedInput.size
          || written.uid !== selectedCreator.ownerId || written.gid !== selectedCreator.groupId
          || (mode(written) & ~0o600) !== 0) {
        throw new Error('Linux protected transfer written file authority is invalid');
      }
      if (written.uid !== selectedOutput.ownerId || written.gid !== selectedOutput.groupId) {
        await outputHandle.chown(selectedOutput.ownerId, selectedOutput.groupId);
      }
      if (mode(written) !== selectedOutput.mode) await outputHandle.chmod(selectedOutput.mode);
      await outputHandle.sync();
      written = await outputHandle.stat();
      requireTransferredPolicy(written, {
        ...selectedOutput,
        size: selectedInput.size,
      }, 'Linux protected transfer staged file policy is invalid');
      if (!sameFile(created, written)) throw new Error('Linux protected transfer staged file identity changed');
    } finally {
      await closeHandle(outputHandle);
    }

    await verifyTransferredFile({
      ...selectedOutput,
      path: pendingPath,
      size: selectedInput.size,
      expectedDigest: selectedInput.digest,
      maximumBytes: selectedMaximum,
    }, ports, readFlags);
    await ports.move(pendingPath, selectedOutput.path);
    await ports.syncDirectory(selectedParent.path);
    const installed = await verifyTransferredFile({
      ...selectedOutput,
      size: selectedInput.size,
      expectedDigest: selectedInput.digest,
      maximumBytes: selectedMaximum,
    }, ports, readFlags);
    return Object.freeze({
      protocol: PROTOCOL,
      path: selectedOutput.path,
      kind: 'file',
      size: installed.size,
      digest: installed.digest,
      changed: true,
    });
  } finally {
    await closeHandle(inputHandle);
  }
}

export { PROTOCOL as LINUX_PROTECTED_STORAGE_PROTOCOL };
