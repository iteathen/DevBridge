import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { sameFilesystemIdentity, sameObservedFilesystemIdentity } from './local-filesystem-identity.js';

export const EXACT_ARTIFACT_SET_PROTOCOL = 'devbridge/exact-artifact-set-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ENTRIES = 8192;
const READ_BYTES = 4 * 1024 * 1024;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function selectedPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function relativePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\0') || value.includes('\\')) {
    throw new TypeError(`${name} is invalid`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw new TypeError(`${name} is invalid`);
  }
  return segments.join('/');
}

function fileIdentity(info) {
  return Object.freeze({
    device: info.dev.toString(),
    inode: info.ino.toString(),
    createdNs: info.birthtimeNs.toString(),
    modifiedNs: info.mtimeNs.toString(),
    size: info.size.toString(),
    links: info.nlink.toString(),
  });
}

function directoryIdentity(info) {
  return Object.freeze({
    device: info.dev.toString(),
    inode: info.ino.toString(),
    createdNs: info.birthtimeNs.toString(),
  });
}

function sameIdentity(left, info) {
  const right = fileIdentity(info);
  return Object.keys(right).every((key) => left?.[key] === right[key]);
}

function sameDirectoryIdentity(left, info) {
  const right = directoryIdentity(info);
  return Object.keys(right).every((key) => left?.[key] === right[key]);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function normalizeExpectedFile(raw, index) {
  const value = onlyKeys(raw, new Set(['relative', 'bytes', 'sha256']), `artifact file ${index}`);
  const bytes = value.bytes == null ? null : value.bytes;
  if (bytes != null && (!Number.isSafeInteger(bytes) || bytes < 0)) throw new TypeError(`artifact file ${index}.bytes is invalid`);
  if (value.sha256 != null && (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256))) throw new TypeError(`artifact file ${index}.sha256 is invalid`);
  return Object.freeze({ relative: relativePath(value.relative, `artifact file ${index}.relative`), bytes, sha256: value.sha256 ?? null });
}

function normalizeExpectedDirectory(value, index) {
  return relativePath(value, `artifact directory ${index}`);
}

function normalizeRequest(raw) {
  const value = onlyKeys(raw, new Set(['identity', 'root', 'files', 'directories', 'exclusive', 'removeRoot']), 'artifact set request');
  if (typeof value.root !== 'string' || value.root.length === 0 || value.root.includes('\0')) throw new TypeError('artifact set root is invalid');
  if (!Array.isArray(value.files) || !Array.isArray(value.directories)
      || value.files.length + value.directories.length > MAX_ENTRIES) throw new TypeError('artifact set entries are invalid');
  const files = value.files.map(normalizeExpectedFile);
  const directories = value.directories.map(normalizeExpectedDirectory);
  const names = [...files.map((entry) => entry.relative), ...directories];
  if (new Set(names).size !== names.length) throw new TypeError('artifact set entries contain duplicate paths');
  if (value.exclusive != null && typeof value.exclusive !== 'boolean') throw new TypeError('artifact set exclusive policy is invalid');
  if (value.removeRoot != null && typeof value.removeRoot !== 'boolean') throw new TypeError('artifact set root-removal policy is invalid');
  const exclusive = value.exclusive ?? true;
  const removeRoot = value.removeRoot ?? true;
  if (files.length + directories.length === 0 && (!exclusive || !removeRoot)) throw new TypeError('empty artifact set must own its removable root');
  return Object.freeze({
    identity: safeId(value.identity, 'artifact set identity'),
    root: value.root,
    files: Object.freeze(files),
    directories: Object.freeze(directories),
    exclusive,
    removeRoot,
  });
}

function normalizeManifest(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'identity', 'root', 'rootIdentity', 'entries', 'digest', 'bytes', 'exclusive', 'removeRoot']), 'artifact set manifest');
  if (value.protocol !== EXACT_ARTIFACT_SET_PROTOCOL) throw new Error('artifact set manifest protocol is unsupported');
  const identity = safeId(value.identity, 'artifact set manifest.identity');
  if (typeof value.root !== 'string' || value.root.length === 0 || value.root.includes('\0')) throw new Error('artifact set manifest root is invalid');
  if (!value.rootIdentity || typeof value.rootIdentity !== 'object' || Array.isArray(value.rootIdentity)) throw new Error('artifact set root identity is invalid');
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) throw new Error('artifact set manifest entries are invalid');
  const entries = value.entries.map((rawEntry, index) => {
    const entry = onlyKeys(rawEntry, new Set(['relative', 'kind', 'identity', 'expectedBytes', 'expectedSha256']), `artifact set manifest entry ${index}`);
    const relative = relativePath(entry.relative, `artifact set manifest entry ${index}.relative`);
    if (!['file', 'directory'].includes(entry.kind)) throw new Error('artifact set manifest entry kind is invalid');
    if (!entry.identity || typeof entry.identity !== 'object' || Array.isArray(entry.identity)) throw new Error('artifact set manifest entry identity is invalid');
    const expectedBytes = entry.expectedBytes == null ? null : entry.expectedBytes;
    if (expectedBytes != null && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) throw new Error('artifact set manifest entry bytes are invalid');
    if (entry.expectedSha256 != null && (typeof entry.expectedSha256 !== 'string' || !SHA256.test(entry.expectedSha256))) throw new Error('artifact set manifest entry digest is invalid');
    return Object.freeze({ relative, kind: entry.kind, identity: Object.freeze({ ...entry.identity }), expectedBytes, expectedSha256: entry.expectedSha256 ?? null });
  });
  if (new Set(entries.map((entry) => entry.relative)).size !== entries.length) throw new Error('artifact set manifest entries contain duplicates');
  if (typeof value.digest !== 'string' || !SHA256.test(value.digest)) throw new Error('artifact set manifest digest is invalid');
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error('artifact set manifest bytes are invalid');
  if (typeof value.exclusive !== 'boolean' || typeof value.removeRoot !== 'boolean') throw new Error('artifact set manifest removal policy is invalid');
  if (entries.length === 0 && (!value.exclusive || !value.removeRoot)) throw new Error('empty artifact set manifest does not own its root');
  const body = { protocol: EXACT_ARTIFACT_SET_PROTOCOL, identity, root: value.root, rootIdentity: value.rootIdentity, entries, bytes: value.bytes, exclusive: value.exclusive, removeRoot: value.removeRoot };
  if (digest(body) !== value.digest) throw new Error('artifact set manifest digest changed');
  return Object.freeze({ ...body, digest: value.digest });
}

function childrenByDirectory(entries) {
  const result = new Map([['', new Set()]]);
  for (const entry of entries) {
    const parts = entry.relative.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      const child = parts[index];
      if (!result.has(parent)) result.set(parent, new Set());
      result.get(parent).add(child);
    }
  }
  return result;
}

async function sha256Handle(handle) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_BYTES);
  let offset = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return Object.freeze({ digest: hash.digest('hex'), bytes: offset });
}

export class ExactArtifactSet {
  #platform;
  #path;
  #inspect;
  #canonicalize;
  #open;
  #list;
  #removeFile;
  #removeDirectory;
  #isReparse;

  constructor({
    platform = process.platform,
    inspect = lstat,
    canonicalize = realpath,
    openFile = open,
    listDirectory = readdir,
    removeFile = unlink,
    removeDirectory = rmdir,
    inspectReparse = null,
  } = {}) {
    if (!['win32', 'linux', 'darwin'].includes(platform)) throw new TypeError('artifact set platform is unsupported');
    for (const [value, name] of [[inspect, 'inspect'], [canonicalize, 'canonicalize'], [openFile, 'openFile'], [listDirectory, 'listDirectory'], [removeFile, 'removeFile'], [removeDirectory, 'removeDirectory']]) {
      if (typeof value !== 'function') throw new TypeError(`artifact set ${name} contract is invalid`);
    }
    if (inspectReparse != null && typeof inspectReparse !== 'function') throw new TypeError('artifact set reparse inspection contract is invalid');
    if (platform === 'win32' && inspectReparse == null) throw new TypeError('Windows artifact set requires a reparse inspection contract');
    this.#platform = platform;
    this.#path = selectedPath(platform);
    this.#inspect = inspect;
    this.#canonicalize = canonicalize;
    this.#open = openFile;
    this.#list = listDirectory;
    this.#removeFile = removeFile;
    this.#removeDirectory = removeDirectory;
    this.#isReparse = inspectReparse ?? (async (_location, info) => info.isSymbolicLink());
  }

  #location(root, relative) {
    const location = this.#path.join(root, ...relative.split('/'));
    const resolved = this.#path.resolve(location);
    const prefix = `${root}${this.#path.sep}`;
    const compare = (value) => this.#platform === 'win32' ? value.toLowerCase() : value;
    if (!compare(resolved).startsWith(compare(prefix))) throw new Error('artifact set entry escaped its root');
    return resolved;
  }

  async #realDirectory(location, expectedIdentity = null) {
    const before = await this.#inspect(location, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || await this.#isReparse(location, before)) throw new Error('artifact set directory is not a real directory');
    const canonical = await this.#canonicalize(location);
    if (!(await sameFilesystemIdentity(location, canonical, { platform: this.#platform, inspect: this.#inspect }))) throw new Error('artifact set directory uses filesystem indirection');
    if (expectedIdentity && !sameDirectoryIdentity(expectedIdentity, before)) throw new Error('artifact set directory identity changed');
    return before;
  }

  async #inspectFile(location, expected = null, { measure = false } = {}) {
    const before = await this.#inspect(location, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || await this.#isReparse(location, before)) throw new Error('artifact set file shape is unsafe');
    if (expected && !sameIdentity(expected.identity, before)) throw new Error('artifact set file identity changed');
    const handle = await this.#open(location, 'r');
    try {
      const held = await handle.stat({ bigint: true });
      if (!held.isFile() || held.nlink !== 1n || !sameObservedFilesystemIdentity(before, held, { platform: this.#platform })) throw new Error('artifact set file changed while opening');
      let measured = null;
      if (measure || expected?.expectedSha256 != null) measured = await sha256Handle(handle);
      const after = await this.#inspect(location, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || await this.#isReparse(location, after)
          || !sameObservedFilesystemIdentity(after, held, { platform: this.#platform }) || !sameIdentity(fileIdentity(held), after)) {
        throw new Error('artifact set file changed during observation');
      }
      const expectedBytes = expected?.expectedBytes;
      if (expectedBytes != null && BigInt(expectedBytes) !== held.size) throw new Error('artifact set file byte count changed');
      if (expected?.expectedSha256 != null && (measured.bytes !== Number(held.size) || measured.digest !== expected.expectedSha256)) throw new Error('artifact set file digest changed');
      return Object.freeze({ info: held, handle, measured, close: false });
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async plan(rawRequest) {
    const request = normalizeRequest(rawRequest);
    const root = this.#path.resolve(request.root);
    const rootInfo = await this.#realDirectory(root);
    const entries = [];
    for (const expected of request.files) {
      const location = this.#location(root, expected.relative);
      const observed = await this.#inspectFile(location, null, { measure: false });
      try {
        if (expected.bytes != null && observed.info.size !== BigInt(expected.bytes)) throw new Error('artifact set file byte count does not match authority');
        entries.push(Object.freeze({
          relative: expected.relative,
          kind: 'file',
          identity: fileIdentity(observed.info),
          expectedBytes: expected.bytes,
          expectedSha256: expected.sha256,
        }));
      } finally {
        await observed.handle.close();
      }
    }
    for (const relative of request.directories) {
      const info = await this.#realDirectory(this.#location(root, relative));
      entries.push(Object.freeze({ relative, kind: 'directory', identity: directoryIdentity(info), expectedBytes: null, expectedSha256: null }));
    }
    entries.sort((left, right) => left.relative.localeCompare(right.relative));
    if (request.exclusive) {
      const expectedChildren = childrenByDirectory(entries);
      for (const [relative, children] of expectedChildren) {
        const directory = relative === '' ? root : this.#location(root, relative);
        await this.#realDirectory(directory, relative === '' ? directoryIdentity(rootInfo) : entries.find((entry) => entry.kind === 'directory' && entry.relative === relative)?.identity);
        const actual = (await this.#list(directory, { withFileTypes: true })).map((entry) => entry.name).sort();
        const expected = [...children].sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('artifact set contains unexpected or missing entries');
      }
    }
    const body = Object.freeze({
      protocol: EXACT_ARTIFACT_SET_PROTOCOL,
      identity: request.identity,
      root,
      rootIdentity: directoryIdentity(rootInfo),
      entries: Object.freeze(entries),
      bytes: entries.filter((entry) => entry.kind === 'file').reduce((total, entry) => total + Number(entry.identity.size), 0),
      exclusive: request.exclusive,
      removeRoot: request.removeRoot,
    });
    return Object.freeze({ ...body, digest: digest(body) });
  }

  async discover(rawRequest) {
    const value = onlyKeys(rawRequest, new Set(['identity', 'root']), 'artifact set discovery request');
    const identity = safeId(value.identity, 'artifact set discovery identity');
    if (typeof value.root !== 'string' || value.root.length === 0 || value.root.includes('\0')) throw new TypeError('artifact set discovery root is invalid');
    const root = this.#path.resolve(value.root);
    await this.#realDirectory(root);
    const files = [];
    const directories = [];
    const pending = [''];
    while (pending.length > 0) {
      const parent = pending.shift();
      const location = parent === '' ? root : this.#location(root, parent);
      await this.#realDirectory(location);
      const entries = await this.#list(location, { withFileTypes: true });
      if (files.length + directories.length + entries.length > MAX_ENTRIES) throw new Error('artifact set discovery exceeds its entry bound');
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relative = parent ? `${parent}/${entry.name}` : entry.name;
        const selected = relativePath(relative, 'artifact set discovered path');
        const child = this.#location(root, selected);
        const info = await this.#inspect(child, { bigint: true });
        if (info.isSymbolicLink() || await this.#isReparse(child, info)) throw new Error('artifact set discovery found filesystem indirection');
        if (info.isDirectory()) {
          directories.push(selected);
          pending.push(selected);
        } else if (info.isFile()) files.push(Object.freeze({ relative: selected, bytes: Number(info.size), sha256: null }));
        else throw new Error('artifact set discovery found an unsupported entry');
      }
    }
    return this.plan({ identity, root, files, directories, exclusive: true, removeRoot: true });
  }

  async observe(rawManifest) {
    const manifest = normalizeManifest(rawManifest);
    let rootInfo;
    try { rootInfo = await this.#realDirectory(manifest.root, manifest.rootIdentity); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ identity: manifest.identity, state: 'absent', retryable: false });
      return Object.freeze({ identity: manifest.identity, state: 'ambiguous', retryable: false });
    }
    void rootInfo;
    const remaining = new Set();
    for (const entry of manifest.entries) {
      const location = this.#location(manifest.root, entry.relative);
      try {
        if (entry.kind === 'file') {
          const observed = await this.#inspectFile(location, entry, { measure: entry.expectedSha256 != null });
          await observed.handle.close();
        } else await this.#realDirectory(location, entry.identity);
        remaining.add(entry.relative);
      } catch (error) {
        if (error?.code !== 'ENOENT') return Object.freeze({ identity: manifest.identity, state: 'ambiguous', retryable: false });
      }
    }
    if (manifest.exclusive) {
      const known = new Set(manifest.entries.map((entry) => entry.relative));
      const directories = ['', ...manifest.entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.relative)];
      for (const relative of directories) {
        const location = relative === '' ? manifest.root : this.#location(manifest.root, relative);
        let entries;
        try { entries = await this.#list(location, { withFileTypes: true }); }
        catch (error) {
          if (error?.code === 'ENOENT') continue;
          return Object.freeze({ identity: manifest.identity, state: 'ambiguous', retryable: false });
        }
        for (const entry of entries) {
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          if (!known.has(child)) return Object.freeze({ identity: manifest.identity, state: 'ambiguous', retryable: false });
        }
      }
    }
    return Object.freeze({
      identity: manifest.identity,
      state: remaining.size === 0 && !manifest.removeRoot ? 'absent' : 'present',
      retryable: true,
    });
  }

  async remove(rawManifest) {
    const manifest = normalizeManifest(rawManifest);
    const before = await this.observe(manifest);
    if (before.state === 'ambiguous') throw new Error('artifact set cannot remove ambiguous state');
    if (before.state === 'absent') return Object.freeze({ identity: manifest.identity, removed: false, absent: true });
    const files = manifest.entries.filter((entry) => entry.kind === 'file').sort((left, right) => right.relative.localeCompare(left.relative));
    for (const entry of files) {
      const location = this.#location(manifest.root, entry.relative);
      let observed;
      try { observed = await this.#inspectFile(location, entry, { measure: entry.expectedSha256 != null }); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      try {
        await this.#removeFile(location);
      } finally {
        await observed.handle.close();
      }
      try { await this.#inspect(location, { bigint: true }); throw new Error('artifact set file remains after removal'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    const directories = manifest.entries.filter((entry) => entry.kind === 'directory')
      .sort((left, right) => right.relative.split('/').length - left.relative.split('/').length || right.relative.localeCompare(left.relative));
    for (const entry of directories) {
      const location = this.#location(manifest.root, entry.relative);
      try {
        await this.#realDirectory(location, entry.identity);
        if ((await this.#list(location)).length !== 0) throw new Error('artifact set directory is not empty');
        await this.#removeDirectory(location);
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    await this.#realDirectory(manifest.root, manifest.rootIdentity);
    if (manifest.removeRoot) {
      if ((await this.#list(manifest.root)).length !== 0) throw new Error('artifact set root is not empty');
      await this.#removeDirectory(manifest.root);
    }
    const after = await this.observe(manifest);
    if (after.state !== 'absent') throw new Error('artifact set did not reconcile to absence');
    return Object.freeze({ identity: manifest.identity, removed: true, absent: false });
  }
}

export function createExactArtifactSet(options) {
  return new ExactArtifactSet(options);
}
