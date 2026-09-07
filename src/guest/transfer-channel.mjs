import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RECORD_PROTOCOL = 'devbridge/transfer-record-v1';
const IDENTITY = /^[a-f0-9]{32}$/u;
const BINDING = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024;
const RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80, 160]);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function boundedString(value, name, { allowEmpty = false, maxBytes = 8_192 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new TypeError(`${name} must be ${allowEmpty ? 'a' : 'a non-empty'} string`);
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is not bounded`);
  return value;
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function canonicalBase64(value, name, maxBytes) {
  const text = boundedString(value, name, { allowEmpty: true, maxBytes: Math.ceil(maxBytes * 4 / 3) + 16 });
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== text) throw new TypeError(`${name} is not canonical bounded base64`);
  return bytes;
}

function validIdentity(value) {
  if (typeof value !== 'string' || !IDENTITY.test(value)) throw new TypeError('transfer identity is invalid');
  return value;
}

function validBinding(value) {
  if (typeof value !== 'string' || !BINDING.test(value)) throw new TypeError('transfer binding is invalid');
  return value;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function atomicRecord(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        const retry = process.platform === 'win32'
          && RENAME_RETRY_CODES.has(error?.code)
          && attempt < RENAME_RETRY_DELAYS_MS.length;
        if (!retry) throw error;
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
      }
    }
  } catch (error) {
    try { await rm(temporary, { force: true }); } catch {}
    throw error;
  }
}

async function readRecord(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 64 * 1024) throw new Error('transfer record is invalid');
  return JSON.parse(await readFile(file, 'utf8'));
}

function validateRecord(raw, identity, binding, destination) {
  const value = requireObject(raw, 'transfer record');
  onlyKeys(value, new Set(['protocol', 'identity', 'binding', 'destination', 'state', 'bytes', 'digest', 'completedAt']), 'transfer record');
  if (value.protocol !== RECORD_PROTOCOL || value.identity !== identity || value.binding !== binding || JSON.stringify(value.destination) !== JSON.stringify(destination)) throw new Error('transfer record identity changed');
  if (!['receiving', 'completed'].includes(value.state) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_TRANSFER_BYTES) throw new Error('transfer record state is invalid');
  if (value.state === 'receiving' && value.digest !== null) throw new Error('receiving transfer record is invalid');
  if (value.state === 'completed' && (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest))) throw new Error('completed transfer record is invalid');
  return value;
}

function normalizePorts(raw) {
  const value = requireObject(raw, 'transfer ports');
  onlyKeys(value, new Set(['normalizeWrite', 'resolveWrite', 'normalizeRead', 'resolveRead']), 'transfer ports');
  for (const name of ['normalizeWrite', 'resolveWrite', 'normalizeRead', 'resolveRead']) if (typeof value[name] !== 'function') throw new TypeError(`transfer ports.${name} must be a function`);
  return value;
}

async function validateResolved(raw, name, { requireFile }) {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['root', 'path']), name);
  if (typeof value.root !== 'string' || !path.isAbsolute(value.root) || typeof value.path !== 'string' || !path.isAbsolute(value.path)) throw new Error(`${name} is invalid`);
  if (!contained(value.root, value.path)) throw new Error(`${name} escaped its boundary`);
  const root = await realpath(value.root);
  const observed = await realpath(requireFile ? value.path : path.dirname(value.path));
  if (!contained(root, observed)) throw new Error(`${name} escaped its boundary`);
  return { root, path: requireFile ? observed : value.path };
}

export async function createTransferChannel({ directory, ...rawPorts }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('transfer directory must be absolute');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('transfer directory must be a real directory');
  const root = await realpath(directory);
  const ports = normalizePorts(rawPorts);
  const partFile = (identity) => path.join(root, `${validIdentity(identity)}.part`);
  const metaFile = (identity) => path.join(root, `${validIdentity(identity)}.json`);

  return Object.freeze({
    async put({ identity: rawIdentity, binding: rawBinding, value: rawValue }) {
      const identity = validIdentity(rawIdentity);
      const binding = validBinding(rawBinding);
      const value = requireObject(rawValue, 'transfer put value');
      onlyKeys(value, new Set(['destination', 'offset', 'data', 'eof', 'digest']), 'transfer put value');
      const destination = await ports.normalizeWrite(value.destination);
      const offset = integer(value.offset, 'transfer put value.offset', 0, MAX_TRANSFER_BYTES);
      const data = canonicalBase64(value.data ?? '', 'transfer put value.data', MAX_CHUNK_BYTES);
      if (typeof value.eof !== 'boolean') throw new TypeError('transfer put value.eof must be boolean');
      if (!value.eof && value.digest != null) throw new TypeError('transfer put value.digest is only allowed at EOF');
      if (value.eof && (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest))) throw new TypeError('transfer put value.digest is invalid');
      if (offset + data.length > MAX_TRANSFER_BYTES) throw new Error('transfer put exceeds the transfer limit');

      const meta = metaFile(identity);
      const part = partFile(identity);
      let record;
      try { record = validateRecord(await readRecord(meta), identity, binding, destination); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (offset !== 0) throw new Error('transfer put continuation has no record');
        record = { protocol: RECORD_PROTOCOL, identity, binding, destination, state: 'receiving', bytes: 0, digest: null };
        await atomicRecord(meta, record);
        await writeFile(part, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
      }
      if (record.state === 'completed') {
        if (!value.eof || offset + data.length !== record.bytes || value.digest !== record.digest) throw new Error('completed transfer put was replayed with different content');
        const resolved = await validateResolved(await ports.resolveWrite(destination, { requireFile: true, createParents: false }), 'transfer write location', { requireFile: true });
        const bytes = await readFile(resolved.path);
        if (bytes.length !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.digest) throw new Error('completed transfer destination changed');
        return { nextOffset: record.bytes, complete: true, digest: record.digest };
      }

      const stagedInfo = await lstat(part);
      if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink() || stagedInfo.size > MAX_TRANSFER_BYTES) throw new Error('transfer staging object is invalid');
      const size = Number(stagedInfo.size);
      if (offset > size) throw new Error('transfer put offset skipped staged bytes');
      if (offset < size) {
        if (offset + data.length > size) throw new Error('transfer put replay overlaps unstaged bytes');
        const handle = await open(part, 'r');
        try {
          const existing = Buffer.alloc(data.length);
          const { bytesRead } = await handle.read(existing, 0, data.length, offset);
          if (bytesRead !== data.length || !existing.equals(data)) throw new Error('transfer put replay bytes do not match staging');
        } finally { await handle.close(); }
      } else if (data.length > 0) {
        const handle = await open(part, 'a');
        try { await handle.write(data); } finally { await handle.close(); }
      }
      const nextOffset = offset + data.length;
      if (!value.eof) return { nextOffset, complete: false, digest: null };

      const staged = await readFile(part);
      if (staged.length !== nextOffset || staged.length > MAX_TRANSFER_BYTES) throw new Error('transfer staging length changed');
      const digest = createHash('sha256').update(staged).digest('hex');
      if (digest !== value.digest) throw new Error('transfer put digest does not match staged bytes');
      const resolved = await validateResolved(await ports.resolveWrite(destination, { createParents: true, requireFile: false }), 'transfer write location', { requireFile: false });
      try {
        const existing = await lstat(resolved.path);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('transfer destination is not a regular file');
        await rm(resolved.path, { force: true });
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await rename(part, resolved.path);
      const finalInfo = await lstat(resolved.path);
      if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) throw new Error('transfer destination shape changed');
      record = { ...record, state: 'completed', bytes: staged.length, digest, completedAt: new Date().toISOString() };
      await atomicRecord(meta, record);
      return { nextOffset: staged.length, complete: true, digest };
    },

    async get({ identity: rawIdentity, binding: rawBinding, value: rawValue }) {
      validIdentity(rawIdentity);
      validBinding(rawBinding);
      const value = requireObject(rawValue, 'transfer get value');
      onlyKeys(value, new Set(['source', 'offset', 'limit']), 'transfer get value');
      const source = await ports.normalizeRead(value.source);
      const offset = integer(value.offset, 'transfer get value.offset', 0, MAX_TRANSFER_BYTES);
      const limit = integer(value.limit, 'transfer get value.limit', 1, MAX_CHUNK_BYTES);
      const resolved = await validateResolved(await ports.resolveRead(source, { requireFile: true }), 'transfer read location', { requireFile: true });
      const info = await stat(resolved.path);
      if (!info.isFile() || info.size > MAX_TRANSFER_BYTES) throw new Error('transfer source exceeds the transfer limit');
      if (offset > info.size) throw new Error('transfer get offset exceeds source length');
      const count = Math.min(limit, Number(info.size) - offset);
      const handle = await open(resolved.path, 'r');
      let data;
      try {
        data = Buffer.alloc(count);
        const { bytesRead } = await handle.read(data, 0, count, offset);
        data = data.subarray(0, bytesRead);
      } finally { await handle.close(); }
      const eof = offset + data.length >= info.size;
      let digest = null;
      if (eof) {
        const complete = await readFile(resolved.path);
        if (complete.length > MAX_TRANSFER_BYTES) throw new Error('transfer source exceeds the transfer limit');
        digest = createHash('sha256').update(complete).digest('hex');
      }
      return { offset, data: data.toString('base64'), eof, digest };
    },
  });
}
