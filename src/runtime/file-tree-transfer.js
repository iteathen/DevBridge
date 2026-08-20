import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readlink, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';

export const FILE_TREE_PROTOCOL = 'devbridge/file-tree-v1';
export const FILE_TREE_DELTA_PROTOCOL = 'devbridge/file-tree-delta-v1';
export const FILE_TREE_VERSION = '1.0.0';
export const FILE_TREE_PART_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_TREE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 24 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const PART_NAME = /^part-[0-9]{1,6}-[0-9]{1,6}$/u;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function digestObject(value) { return sha256(Buffer.from(stableJson(value), 'utf8')); }
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function normalizeTreePath(value, name = 'tree path') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 4096) throw new TypeError(`${name} is invalid`);
  const portable = value.replace(/\\/gu, '/');
  if (portable.startsWith('/') || portable.startsWith('//') || /^[A-Za-z]:/u.test(portable) || portable.includes(':')) throw new TypeError(`${name} must be portable and relative`);
  const segments = portable.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new TypeError(`${name} contains an invalid segment`);
  return segments.join('/');
}

function normalizeSymlinkTarget(value, entryPath, root) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 4096 || path.isAbsolute(value)) {
    throw new TypeError(`tree symlink target is invalid for ${entryPath}`);
  }
  const parent = path.dirname(path.join(root, ...entryPath.split('/')));
  const resolved = path.resolve(parent, value);
  if (!isWithin(root, resolved)) throw new TypeError(`tree symlink target escapes root for ${entryPath}`);
  return value;
}

async function fileDigest(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function partDigest(file, offset, length) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, offset + read);
      if (result.bytesRead === 0) throw new Error('tree source file became shorter while hashing a transfer part');
      read += result.bytesRead;
    }
    return sha256(buffer);
  } finally { await handle.close(); }
}

function manifestBytes(manifest) {
  const text = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('file tree manifest exceeds the bounded transfer floor');
  return Buffer.from(text, 'utf8');
}

export async function snapshotFileTree({ root, listPaths, acceptPath = () => true, partBytes = FILE_TREE_PART_BYTES } = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('file tree root is required');
  if (typeof listPaths !== 'function') throw new TypeError('file tree listPaths must be a function');
  if (typeof acceptPath !== 'function') throw new TypeError('file tree acceptPath must be a function');
  if (!Number.isSafeInteger(partBytes) || partBytes < 1024 * 1024 || partBytes > FILE_TREE_PART_BYTES) throw new TypeError('file tree partBytes is invalid');
  const canonicalRoot = await realpath(path.resolve(root));
  const rootInfo = await lstat(canonicalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('file tree root must be a real directory');
  const rawPaths = await listPaths(canonicalRoot);
  if (!Array.isArray(rawPaths) || rawPaths.length > MAX_ENTRIES * 2) throw new Error('file tree path inventory is invalid or oversized');
  const paths = [...new Set(rawPaths.map((entry, index) => normalizeTreePath(entry, `file tree path[${index}]`)))].sort();
  const entries = [];
  let totalBytes = 0;
  for (const relative of paths) {
    if (!acceptPath(relative)) continue;
    const candidate = path.join(canonicalRoot, ...relative.split('/'));
    if (!isWithin(canonicalRoot, candidate)) throw new Error(`file tree path escaped root: ${relative}`);
    let info;
    try { info = await lstat(candidate); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (info.isDirectory()) continue;
    if (entries.length >= MAX_ENTRIES) throw new Error(`file tree exceeds ${MAX_ENTRIES} entries`);
    if (info.isSymbolicLink()) {
      const target = normalizeSymlinkTarget(await readlink(candidate), relative, canonicalRoot);
      entries.push({ path: relative, type: 'symlink', target });
      continue;
    }
    if (!info.isFile()) throw new Error(`file tree contains unsupported file type: ${relative}`);
    if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error(`file tree size is invalid: ${relative}`);
    totalBytes += info.size;
    if (totalBytes > MAX_TREE_BYTES) throw new Error('file tree exceeds the bounded byte ceiling');
    const parts = [];
    for (let offset = 0, index = 0; offset < info.size || (info.size === 0 && index === 0); index += 1) {
      const length = info.size === 0 ? 0 : Math.min(partBytes, info.size - offset);
      const name = `part-${entries.length}-${index}`;
      const digest = length === 0 ? sha256(Buffer.alloc(0)) : await partDigest(candidate, offset, length);
      parts.push({ name, offset, size: length, digest });
      if (info.size === 0) break;
      offset += length;
    }
    entries.push({ path: relative, type: 'file', size: info.size, digest: await fileDigest(candidate), executable: (info.mode & 0o111) !== 0, parts });
  }
  const body = { protocol: FILE_TREE_PROTOCOL, version: FILE_TREE_VERSION, entries, totalBytes };
  const digest = digestObject(body);
  const manifest = Object.freeze({ ...body, digest });
  manifestBytes(manifest);
  return Object.freeze({
    root: canonicalRoot,
    manifest,
    manifestBytes: () => manifestBytes(manifest),
    async readPart(name, { offset = 0, limit = 16 * 1024 } = {}) {
      if (typeof name !== 'string' || !PART_NAME.test(name)) throw new TypeError('file tree part name is invalid');
      const entry = entries.find((item) => item.type === 'file' && item.parts.some((part) => part.name === name));
      if (!entry) throw new Error('file tree part is unknown');
      const part = entry.parts.find((item) => item.name === name);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > part.size) throw new TypeError('file tree part offset is invalid');
      if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('file tree part limit is invalid');
      const remaining = part.size - offset;
      const length = Math.min(limit, remaining);
      if (part.size === 0) return { data: Buffer.alloc(0), eof: true };
      const handle = await open(path.join(canonicalRoot, ...entry.path.split('/')), 'r');
      try {
        const data = Buffer.allocUnsafe(length);
        const result = await handle.read(data, 0, length, part.offset + offset);
        const actual = data.subarray(0, result.bytesRead);
        return { data: actual, eof: offset + actual.length === part.size };
      } finally { await handle.close(); }
    },
  });
}

function requireObject(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`); return value; }
function onlyKeys(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`); }
function exactDigest(value, name) { const text = String(value ?? '').toLowerCase(); if (!DIGEST.test(text)) throw new TypeError(`${name} is invalid`); return text; }

export function normalizeFileTreeDelta(raw, { root = path.parse(process.cwd()).root, acceptPath = () => true } = {}) {
  const value = requireObject(raw, 'file tree delta');
  onlyKeys(value, new Set(['protocol', 'version', 'basisDigest', 'entries', 'totalBytes', 'digest']), 'file tree delta');
  if (value.protocol !== FILE_TREE_DELTA_PROTOCOL || value.version !== FILE_TREE_VERSION) throw new TypeError('file tree delta protocol is unsupported');
  const basisDigest = exactDigest(value.basisDigest, 'file tree delta.basisDigest');
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) throw new TypeError('file tree delta entries are invalid');
  let totalBytes = 0;
  const seen = new Set();
  const entries = value.entries.map((rawEntry, index) => {
    const entry = requireObject(rawEntry, `file tree delta.entries[${index}]`);
    const relative = normalizeTreePath(entry.path, `file tree delta.entries[${index}].path`);
    if (!acceptPath(relative)) throw new TypeError(`file tree delta path is not admitted: ${relative}`);
    if (seen.has(relative)) throw new TypeError(`file tree delta duplicates path: ${relative}`);
    seen.add(relative);
    if (entry.action === 'delete') {
      onlyKeys(entry, new Set(['path', 'action']), `file tree delta.entries[${index}]`);
      return { path: relative, action: 'delete' };
    }
    if (entry.action === 'symlink') {
      onlyKeys(entry, new Set(['path', 'action', 'target']), `file tree delta.entries[${index}]`);
      return { path: relative, action: 'symlink', target: normalizeSymlinkTarget(entry.target, relative, root) };
    }
    if (entry.action !== 'write') throw new TypeError(`file tree delta.entries[${index}].action is invalid`);
    onlyKeys(entry, new Set(['path', 'action', 'size', 'digest', 'executable', 'parts']), `file tree delta.entries[${index}]`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new TypeError('file tree delta file size is invalid');
    totalBytes += entry.size;
    if (totalBytes > MAX_TREE_BYTES) throw new TypeError('file tree delta exceeds the bounded byte ceiling');
    if (typeof entry.executable !== 'boolean') throw new TypeError('file tree delta executable flag is invalid');
    if (!Array.isArray(entry.parts) || entry.parts.length === 0) throw new TypeError('file tree delta parts are invalid');
    let expectedOffset = 0;
    const parts = entry.parts.map((rawPart, partIndex) => {
      const part = requireObject(rawPart, `file tree delta part[${partIndex}]`);
      onlyKeys(part, new Set(['name', 'offset', 'size', 'digest']), 'file tree delta part');
      if (typeof part.name !== 'string' || !PART_NAME.test(part.name)) throw new TypeError('file tree delta part name is invalid');
      if (!Number.isSafeInteger(part.offset) || part.offset !== expectedOffset || !Number.isSafeInteger(part.size) || part.size < 0 || part.size > FILE_TREE_PART_BYTES) throw new TypeError('file tree delta part bounds are invalid');
      expectedOffset += part.size;
      return { name: part.name, offset: part.offset, size: part.size, digest: exactDigest(part.digest, 'file tree delta part digest') };
    });
    if (expectedOffset !== entry.size) throw new TypeError('file tree delta parts do not cover the file size exactly');
    return { path: relative, action: 'write', size: entry.size, digest: exactDigest(entry.digest, 'file tree delta file digest'), executable: entry.executable, parts };
  });
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes !== totalBytes) throw new TypeError('file tree delta totalBytes is inconsistent');
  const body = { protocol: value.protocol, version: value.version, basisDigest, entries, totalBytes };
  const digest = exactDigest(value.digest, 'file tree delta.digest');
  if (digestObject(body) !== digest) throw new TypeError('file tree delta digest is inconsistent');
  manifestBytes({ ...body, digest });
  return Object.freeze({ ...body, digest });
}

async function ensureSafeParent(root, relative) {
  const segments = relative.split('/');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(current, segment);
    try {
      const info = await lstat(next);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`file tree destination parent is unsafe: ${relative}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(next, { mode: 0o700 });
    }
    current = await realpath(next);
    if (!isWithin(root, current)) throw new Error(`file tree destination parent escaped root: ${relative}`);
  }
  return path.join(root, ...segments);
}

export async function stageFileTreeDelta({ manifest, root, stagingRoot, readPart, acceptPath = () => true } = {}) {
  if (typeof readPart !== 'function') throw new TypeError('file tree delta readPart must be a function');
  const canonicalRoot = await realpath(path.resolve(root));
  const normalized = normalizeFileTreeDelta(manifest, { root: canonicalRoot, acceptPath });
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  for (const entry of normalized.entries) {
    if (entry.action !== 'write') continue;
    const destination = await ensureSafeParent(path.resolve(stagingRoot), entry.path);
    const temporary = `${destination}.${randomUUID()}.part`;
    const handle = await open(temporary, 'wx', 0o600);
    const whole = createHash('sha256');
    try {
      for (const part of entry.parts) {
        const bytes = Buffer.from(await readPart(part.name));
        if (bytes.length !== part.size || sha256(bytes) !== part.digest) throw new Error(`file tree delta part failed digest validation: ${part.name}`);
        await handle.write(bytes, 0, bytes.length, part.offset);
        whole.update(bytes);
      }
    } finally { await handle.close(); }
    if (whole.digest('hex') !== entry.digest) { await rm(temporary, { force: true }); throw new Error(`file tree delta file failed digest validation: ${entry.path}`); }
    await rename(temporary, destination);
  }
  return normalized;
}

export async function applyStagedFileTreeDelta({ root, stagingRoot, manifest, acceptPath = () => true } = {}) {
  const canonicalRoot = await realpath(path.resolve(root));
  const normalized = normalizeFileTreeDelta(manifest, { root: canonicalRoot, acceptPath });
  for (const entry of normalized.entries) {
    const destination = await ensureSafeParent(canonicalRoot, entry.path);
    let existing = null;
    try { existing = await lstat(destination); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (entry.action === 'delete') {
      if (!existing) continue;
      if (existing.isDirectory() && !existing.isSymbolicLink()) throw new Error(`file tree delta will not recursively delete a directory: ${entry.path}`);
      await rm(destination, { force: false });
      continue;
    }
    if (entry.action === 'symlink') {
      if (existing?.isDirectory() && !existing.isSymbolicLink()) throw new Error(`file tree delta will not replace a directory: ${entry.path}`);
      const temporary = `${destination}.${randomUUID()}.link`;
      await symlink(entry.target, temporary);
      await rename(temporary, destination);
      continue;
    }
    if (existing?.isDirectory() && !existing.isSymbolicLink()) throw new Error(`file tree delta will not replace a directory: ${entry.path}`);
    const staged = path.join(path.resolve(stagingRoot), ...entry.path.split('/'));
    const info = await stat(staged);
    if (!info.isFile() || info.size !== entry.size || await fileDigest(staged) !== entry.digest) throw new Error(`staged file tree delta changed before apply: ${entry.path}`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await copyFile(staged, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, entry.executable ? 0o755 : 0o644).catch(() => {});
    await rename(temporary, destination);
  }
  return normalized;
}

export function fileTreeManifestDigest(manifest) {
  if (!manifest || manifest.protocol !== FILE_TREE_PROTOCOL || manifest.version !== FILE_TREE_VERSION || typeof manifest.digest !== 'string') throw new TypeError('file tree manifest is invalid');
  return manifest.digest;
}
