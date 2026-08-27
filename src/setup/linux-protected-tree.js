import { createHash } from 'node:crypto';
import path from 'node:path';

const PROTOCOL = 'devbridge/linux-protected-tree-v1';
const DIGEST = /^[0-9a-f]{64}$/u;
const PENDING_SUFFIX = '.devbridge-pending';
const MAX_DIRECTORIES = 4_096;
const MAX_ENTRIES = 4_096;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 512 * 1024 * 1024;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || /[\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value || value === '/') {
    throw new TypeError(`${name} must be a normalized absolute Linux path`);
  }
  return value;
}

function relativePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || /[\0\r\n]/u.test(value)
      || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || ['.', '..'].includes(value)
      || value.split('/').some((segment) => segment.length === 0 || segment.length > 255 || segment === '..' || segment.endsWith(PENDING_SUFFIX))) {
    throw new TypeError(`${name} must be a normalized relative Linux path`);
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

function positive(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function fileDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function contract(value, name, { nullableMode = false } = {}) {
  exactKeys(value, new Set(['path', 'ownerId', 'groupId', 'mode']), name);
  return Object.freeze({
    path: absolutePath(value.path, `${name} path`),
    ownerId: identifier(value.ownerId, `${name} owner`),
    groupId: identifier(value.groupId, `${name} group`),
    mode: accessMode(value.mode, `${name} mode`, { nullable: nullableMode }),
  });
}

function location(value, name, ownerId, groupId, directoryMode) {
  exactKeys(value, new Set(['path', 'parent']), name);
  const parent = contract(value.parent, `${name} parent`, { nullableMode: true });
  const selected = Object.freeze({
    path: absolutePath(value.path, `${name} path`),
    ownerId,
    groupId,
    mode: directoryMode,
  });
  if (path.posix.dirname(selected.path) !== parent.path) throw new TypeError(`${name} must be an immediate child of its parent`);
  return Object.freeze({ contract: selected, parent });
}

function input(value, maximumBytes, name) {
  exactKeys(value, new Set(['path', 'size', 'digest']), name);
  return Object.freeze({
    path: absolutePath(value.path, `${name} path`),
    size: positive(value.size, `${name} size`, maximumBytes),
    digest: digest(value.digest, `${name} digest`),
  });
}

function normalizeEntry(value, index) {
  const name = `Linux protected tree entry ${index}`;
  if (value?.kind === 'transfer') {
    exactKeys(value, new Set(['kind', 'relative', 'mode', 'maximumBytes', 'input']), name);
    const maximumBytes = positive(value.maximumBytes, `${name} maximum`, MAX_ENTRY_BYTES);
    return Object.freeze({
      kind: 'transfer',
      relative: relativePath(value.relative, `${name} path`),
      mode: accessMode(value.mode, `${name} mode`),
      maximumBytes,
      input: input(value.input, maximumBytes, `${name} input`),
      size: value.input.size,
      digest: value.input.digest,
    });
  }
  if (value?.kind === 'content') {
    exactKeys(value, new Set(['kind', 'relative', 'mode', 'maximumBytes', 'content']), name);
    const maximumBytes = positive(value.maximumBytes, `${name} maximum`, MAX_CONTENT_BYTES);
    const content = Buffer.isBuffer(value.content) ? Buffer.from(value.content) : Buffer.from(String(value.content), 'utf8');
    if (content.length < 1 || content.length > maximumBytes) throw new TypeError(`${name} content is outside its bound`);
    return Object.freeze({
      kind: 'content',
      relative: relativePath(value.relative, `${name} path`),
      mode: accessMode(value.mode, `${name} mode`),
      maximumBytes,
      content,
      size: content.length,
      digest: fileDigest(content),
    });
  }
  throw new TypeError(`${name} kind is invalid`);
}

function depth(value) {
  return value.split('/').length;
}

function codePointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function atOrBelow(root, target) {
  const relative = path.posix.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

function normalizeRequest(value) {
  exactKeys(value, new Set([
    'working',
    'installed',
    'ownerId',
    'groupId',
    'creatorIds',
    'directoryMode',
    'directories',
    'entries',
  ]), 'Linux protected tree request');
  const ownerId = identifier(value.ownerId, 'Linux protected tree owner');
  const groupId = identifier(value.groupId, 'Linux protected tree group');
  const creatorIds = exactKeys(value.creatorIds, new Set(['ownerId', 'groupId']), 'Linux protected tree creator');
  const creator = Object.freeze({
    ownerId: identifier(creatorIds.ownerId, 'Linux protected tree creator owner'),
    groupId: identifier(creatorIds.groupId, 'Linux protected tree creator group'),
  });
  const directoryMode = accessMode(value.directoryMode, 'Linux protected tree directory mode');
  const working = location(value.working, 'Linux protected tree working root', ownerId, groupId, directoryMode);
  const installed = location(value.installed, 'Linux protected tree installed root', ownerId, groupId, directoryMode);
  if (working.contract.path === installed.contract.path) throw new TypeError('Linux protected tree roots must be distinct');
  if (atOrBelow(working.contract.path, installed.contract.path)
      || atOrBelow(installed.contract.path, working.contract.path)
      || atOrBelow(working.contract.path, installed.parent.path)
      || atOrBelow(installed.contract.path, working.parent.path)) {
    throw new TypeError('Linux protected tree topology overlaps its roots');
  }
  if (!Array.isArray(value.directories) || value.directories.length > MAX_DIRECTORIES) throw new TypeError('Linux protected tree directories are invalid');
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAX_ENTRIES) throw new TypeError('Linux protected tree entries are invalid');
  const directories = value.directories.map((entry, index) => relativePath(entry, `Linux protected tree directory ${index}`));
  if (new Set(directories).size !== directories.length) throw new TypeError('Linux protected tree directories are ambiguous');
  const directorySet = new Set(directories);
  for (const relative of directories) {
    const parent = path.posix.dirname(relative);
    if (parent !== '.' && !directorySet.has(parent)) throw new TypeError('Linux protected tree directory parent is undeclared');
  }
  directories.sort((left, right) => depth(left) - depth(right) || codePointCompare(left, right));
  const entries = value.entries.map(normalizeEntry);
  const entryPaths = entries.map((entry) => entry.relative);
  if (new Set(entryPaths).size !== entryPaths.length || entryPaths.some((entry) => directorySet.has(entry))) {
    throw new TypeError('Linux protected tree entry paths are ambiguous');
  }
  let totalBytes = 0;
  for (const entry of entries) {
    const parent = path.posix.dirname(entry.relative);
    if (parent !== '.' && !directorySet.has(parent)) throw new TypeError('Linux protected tree entry parent is undeclared');
    if (entry.kind === 'transfer' && (atOrBelow(working.contract.path, entry.input.path) || atOrBelow(installed.contract.path, entry.input.path))) {
      throw new TypeError('Linux protected tree input aliases managed state');
    }
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TREE_BYTES) throw new TypeError('Linux protected tree bytes exceed their bound');
  }
  entries.sort((left, right) => codePointCompare(left.relative, right.relative));
  return Object.freeze({ ownerId, groupId, creatorIds: creator, directoryMode, working, installed, directories: Object.freeze(directories), entries: Object.freeze(entries) });
}

function requirePorts(ports) {
  const names = ['observeEntry', 'ensureDirectory', 'writeContent', 'transferContent', 'verifyFile', 'listDirectory', 'move', 'syncDirectory'];
  for (const name of names) if (typeof ports?.[name] !== 'function') throw new TypeError(`Linux protected tree ${name} port is invalid`);
  return ports;
}

function ready(value) {
  return value?.exists === true && value.kind === true && value.owner === true && value.group === true && value.mode === true;
}

function entryContract(root, relative, request, mode) {
  return Object.freeze({
    path: path.posix.join(root, relative),
    ownerId: request.ownerId,
    groupId: request.groupId,
    mode,
  });
}

function directoryContract(root, relative, request) {
  return entryContract(root, relative, request, request.directoryMode);
}

function declaredChildren(request) {
  const children = new Map([['.', new Map()]]);
  const add = (relative, kind, entry = null) => {
    const parent = path.posix.dirname(relative);
    if (!children.has(parent)) children.set(parent, new Map());
    children.get(parent).set(path.posix.basename(relative), Object.freeze({ kind, relative, entry }));
    if (kind === 'directory' && !children.has(relative)) children.set(relative, new Map());
  };
  for (const relative of request.directories) add(relative, 'directory');
  for (const entry of request.entries) add(entry.relative, 'file', entry);
  return children;
}

function exactNames(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('Linux protected tree directory listing is outside its bound');
  const names = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > 255 || /[\/\0\r\n]/u.test(entry) || ['.', '..'].includes(entry)) {
      throw new Error('Linux protected tree directory listing is invalid');
    }
    return entry;
  });
  if (new Set(names).size !== names.length) throw new Error('Linux protected tree directory listing is ambiguous');
  return names.sort(codePointCompare);
}

async function inspectWorkingTree(request, ports, children) {
  const root = await ports.observeEntry({ contract: request.working.contract, kind: 'directory' });
  if (!root.exists) return false;
  if (!ready(root)) throw new Error('Linux protected tree working root policy is invalid');
  let observedEntries = 0;
  const visit = async (relative) => {
    const target = relative === '.' ? request.working.contract.path : path.posix.join(request.working.contract.path, relative);
    const declared = children.get(relative) ?? new Map();
    const names = exactNames(await ports.listDirectory(target), declared.size * 2 + 1);
    for (const name of names) {
      observedEntries += 1;
      if (observedEntries > MAX_DIRECTORIES + (MAX_ENTRIES * 2)) throw new Error('Linux protected tree working state exceeds its bound');
      const selected = declared.get(name);
      if (selected == null) {
        const base = name.endsWith(PENDING_SUFFIX) ? name.slice(0, -PENDING_SUFFIX.length) : null;
        if (base == null || declared.get(base)?.kind !== 'file') throw new Error('Linux protected tree working state contains an undeclared entry');
        continue;
      }
      const selectedContract = selected.kind === 'directory'
        ? directoryContract(request.working.contract.path, selected.relative, request)
        : entryContract(request.working.contract.path, selected.relative, request, selected.entry.mode);
      const observed = await ports.observeEntry({ contract: selectedContract, kind: selected.kind });
      if (selected.kind === 'directory') {
        if (!ready(observed)) throw new Error('Linux protected tree working directory policy is invalid');
        await visit(selected.relative);
      } else if (!(observed.exists && observed.kind && observed.owner && observed.group)) {
        throw new Error('Linux protected tree working file authority is invalid');
      }
    }
  };
  await visit('.');
  return true;
}

async function verifyTree(locationValue, request, ports, children) {
  const root = await ports.observeEntry({ contract: locationValue.contract, kind: 'directory' });
  if (!ready(root)) throw new Error('Linux protected tree root policy is invalid');
  let observedEntries = 0;
  const visit = async (relative) => {
    const target = relative === '.' ? locationValue.contract.path : path.posix.join(locationValue.contract.path, relative);
    const declared = children.get(relative) ?? new Map();
    const names = exactNames(await ports.listDirectory(target), declared.size);
    const expected = [...declared.keys()].sort(codePointCompare);
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      throw new Error('Linux protected tree contents are not exact');
    }
    for (const name of names) {
      observedEntries += 1;
      if (observedEntries > MAX_DIRECTORIES + MAX_ENTRIES) throw new Error('Linux protected tree verification exceeds its bound');
      const selected = declared.get(name);
      if (selected.kind === 'directory') {
        const selectedContract = directoryContract(locationValue.contract.path, selected.relative, request);
        const observed = await ports.observeEntry({ contract: selectedContract, kind: 'directory' });
        if (!ready(observed)) throw new Error('Linux protected tree directory policy is invalid');
        await visit(selected.relative);
      } else {
        const selectedContract = entryContract(locationValue.contract.path, selected.relative, request, selected.entry.mode);
        const observed = await ports.verifyFile({
          contract: selectedContract,
          size: selected.entry.size,
          digest: selected.entry.digest,
          maximumBytes: selected.entry.maximumBytes,
        });
        if (observed?.ready !== true || observed.size !== selected.entry.size || observed.digest !== selected.entry.digest) {
          throw new Error('Linux protected tree file evidence is invalid');
        }
      }
    }
  };
  await visit('.');
  return Object.freeze({ entries: observedEntries });
}

async function syncParents(request, ports) {
  const parents = [...new Set([request.working.parent.path, request.installed.parent.path])];
  for (const parent of parents) await ports.syncDirectory(parent);
}

export async function installLinuxProtectedTree(value, providedPorts) {
  const request = normalizeRequest(value);
  const ports = requirePorts(providedPorts);
  const children = declaredChildren(request);
  for (const selected of [request.working.parent, request.installed.parent]) {
    const observed = await ports.observeEntry({ contract: selected, kind: 'directory' });
    if (!ready(observed)) throw new Error('Linux protected tree parent authority is invalid');
  }

  const working = await ports.observeEntry({ contract: request.working.contract, kind: 'directory' });
  const installed = await ports.observeEntry({ contract: request.installed.contract, kind: 'directory' });
  if (installed.exists) {
    if (working.exists) throw new Error('Linux protected tree working and installed roots are ambiguous');
    const observed = await verifyTree(request.installed, request, ports, children);
    await syncParents(request, ports);
    return Object.freeze({ protocol: PROTOCOL, path: request.installed.contract.path, entries: observed.entries, changed: false });
  }
  if (working.exists) await inspectWorkingTree(request, ports, children);

  await ports.ensureDirectory({ contract: request.working.contract, parent: request.working.parent });
  for (const relative of request.directories) {
    const parentRelative = path.posix.dirname(relative);
    const parent = parentRelative === '.'
      ? request.working.contract
      : directoryContract(request.working.contract.path, parentRelative, request);
    await ports.ensureDirectory({ contract: directoryContract(request.working.contract.path, relative, request), parent });
  }
  for (const entry of request.entries) {
    const parentRelative = path.posix.dirname(entry.relative);
    const parent = parentRelative === '.'
      ? request.working.contract
      : directoryContract(request.working.contract.path, parentRelative, request);
    const selected = entryContract(request.working.contract.path, entry.relative, request, entry.mode);
    if (entry.kind === 'content') {
      await ports.writeContent({ contract: selected, parent, content: entry.content, maximumBytes: entry.maximumBytes });
    } else {
      await ports.transferContent({
        input: entry.input,
        output: selected,
        parent,
        creatorIds: request.creatorIds,
        maximumBytes: entry.maximumBytes,
      });
    }
  }
  const staged = await verifyTree(request.working, request, ports, children);
  const collision = await ports.observeEntry({ contract: request.installed.contract, kind: 'directory' });
  if (collision.exists) throw new Error('Linux protected tree installed root appeared before publication');
  await ports.move(request.working.contract.path, request.installed.contract.path);
  await syncParents(request, ports);
  const installedTree = await verifyTree(request.installed, request, ports, children);
  if (installedTree.entries !== staged.entries) throw new Error('Linux protected tree publication evidence changed');
  return Object.freeze({ protocol: PROTOCOL, path: request.installed.contract.path, entries: installedTree.entries, changed: true });
}

export { PROTOCOL as LINUX_PROTECTED_TREE_PROTOCOL };
