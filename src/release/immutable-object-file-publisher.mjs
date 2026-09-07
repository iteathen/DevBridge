import { createHash } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  IMMUTABLE_OBJECT_SET_PROTOCOL,
  normalizeImmutableObjectSet,
} from '../runtime/immutable-object-set.js';
import {
  sameFilesystemIdentity,
  sameObservedFilesystemIdentity,
} from '../runtime/local-filesystem-identity.js';

export const DEFAULT_IMMUTABLE_OBJECT_CHUNK_BYTES = 64 * 1024 * 1024;

const MAX_OBJECT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_OBJECTS = 8192;
const MAX_CHUNKS_PER_OBJECT = 16_384;
const COPY_BYTES = 4 * 1024 * 1024;
const SAFE_LEAF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function exactRequest(raw, allowed) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('immutable-object publication request must be an object');
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`immutable-object publication request.${key} is unsupported`);
  return raw;
}

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function writeAll(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (bytesWritten < 1) fail('immutable-object publication write did not advance');
    offset += bytesWritten;
  }
}

async function exactPublishedFile(location, size, digest) {
  const info = await lstat(location, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size !== BigInt(size)) return false;
  const bytes = await readFile(location);
  return bytes.length === size && sha256(bytes) === digest;
}

async function publishChunk(temporary, destination, size, digest) {
  try {
    await link(temporary, destination);
    await unlink(temporary);
  } catch (error) {
    if (error?.code !== 'EEXIST' || !await exactPublishedFile(destination, size, digest)) throw error;
    await unlink(temporary);
  }
}

async function validateInput(location, name) {
  if (typeof location !== 'string' || !path.isAbsolute(location) || location.includes('\0')) {
    throw new TypeError(`immutable-object input ${name} location is invalid`);
  }
  const resolved = path.resolve(location);
  const canonical = await realpath(resolved);
  if (!await sameFilesystemIdentity(resolved, canonical)) {
    fail(`immutable-object input ${name} must use a direct nonsymbolic path`);
  }
  const info = await lstat(resolved, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 1n
      || info.size > BigInt(MAX_OBJECT_BYTES)) {
    fail(`immutable-object input ${name} must be one bounded unlinked regular file`);
  }
  return Object.freeze({ location: resolved, info });
}

async function publishObject({ name, location, before }, objectRoot, chunkBytes, signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('immutable-object publication was interrupted');
  const size = Number(before.size);
  const chunkCount = Math.ceil(size / chunkBytes);
  if (chunkCount > MAX_CHUNKS_PER_OBJECT) fail(`immutable-object input ${name} requires too many chunks`);
  const input = await open(location, 'r');
  const held = await input.stat({ bigint: true });
  if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) {
    await input.close();
    fail(`immutable-object input ${name} changed while opening`);
  }
  const whole = createHash('sha256');
  const chunks = [];
  try {
    let sourceOffset = 0;
    for (let ordinal = 0; sourceOffset < size; ordinal += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error('immutable-object publication was interrupted');
      const selectedSize = Math.min(chunkBytes, size - sourceOffset);
      const temporary = path.join(objectRoot, `.chunk-${name}-${String(ordinal).padStart(6, '0')}.tmp`);
      const output = await open(temporary, 'wx', 0o600);
      const chunkHash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.min(COPY_BYTES, selectedSize));
      let copied = 0;
      try {
        while (copied < selectedSize) {
          if (signal?.aborted) throw signal.reason ?? new Error('immutable-object publication was interrupted');
          const requested = Math.min(buffer.length, selectedSize - copied);
          const { bytesRead } = await input.read(buffer, 0, requested, sourceOffset + copied);
          if (bytesRead !== requested) fail(`immutable-object input ${name} ended while reading`);
          const frame = buffer.subarray(0, bytesRead);
          await writeAll(output, frame, copied);
          chunkHash.update(frame);
          whole.update(frame);
          copied += bytesRead;
        }
        await output.sync();
      } finally { await output.close(); }
      const digest = chunkHash.digest('hex');
      await publishChunk(temporary, path.join(objectRoot, digest), selectedSize, digest);
      chunks.push(Object.freeze({
        ordinal,
        name: `${name}.${String(ordinal).padStart(6, '0')}`,
        offset: sourceOffset,
        size: selectedSize,
        sha256: digest,
      }));
      sourceOffset += selectedSize;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await input.read(extra, 0, 1, size)).bytesRead !== 0) fail(`immutable-object input ${name} grew while reading`);
    const after = await lstat(location, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(held, after)) {
      fail(`immutable-object input ${name} changed while reading`);
    }
    return Object.freeze({ name, size, sha256: whole.digest('hex'), chunks: Object.freeze(chunks) });
  } finally { await input.close(); }
}

export async function publishImmutableObjectFiles(raw = {}) {
  const request = exactRequest(raw, new Set(['destination', 'subject', 'inputs', 'chunkBytes', 'signal']));
  const {
    destination,
    subject,
    inputs,
    chunkBytes = DEFAULT_IMMUTABLE_OBJECT_CHUNK_BYTES,
    signal = null,
  } = request;
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) {
    throw new TypeError('immutable-object publication destination is invalid');
  }
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_OBJECTS) {
    throw new TypeError('immutable-object publication inputs are invalid');
  }
  if (typeof subject !== 'string' || !SAFE_ID.test(subject)) throw new TypeError('immutable-object publication subject is invalid');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
    throw new TypeError('immutable-object publication chunk size is invalid');
  }
  if (signal != null && typeof signal !== 'object') throw new TypeError('immutable-object publication signal is invalid');
  if (signal?.aborted) throw signal.reason ?? new Error('immutable-object publication was interrupted');
  const names = new Set();
  const selected = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['name', 'location'].includes(key))) {
      throw new TypeError(`immutable-object publication input ${index} is invalid`);
    }
    if (typeof input.name !== 'string' || input.name === '.' || input.name === '..'
        || !SAFE_LEAF.test(input.name) || names.has(input.name)) {
      throw new TypeError('immutable-object publication input names must be unique');
    }
    names.add(input.name);
    const observed = await validateInput(input.location, input.name);
    if (selected.some((entry) => sameObservedFilesystemIdentity(entry.before, observed.info))) {
      fail('immutable-object publication input files must be distinct');
    }
    selected.push(Object.freeze({ name: input.name, location: observed.location, before: observed.info }));
  }
  const root = path.resolve(destination);
  try { await mkdir(root, { recursive: false, mode: 0o700 }); }
  catch (error) { if (error?.code === 'EEXIST') fail('immutable-object publication destination already exists'); throw error; }
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('immutable-object publication destination must be a real directory');
    const objects = [];
    for (const input of selected) objects.push(await publishObject(input, root, chunkBytes, signal));
    const descriptor = normalizeImmutableObjectSet({
      protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
      subject,
      objects,
    });
    return Object.freeze({
      root,
      descriptor,
      objectDigests: Object.freeze([...new Set(descriptor.objects.flatMap((object) => object.chunks.map((chunk) => chunk.sha256)))]),
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
