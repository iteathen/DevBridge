import { createHash } from 'node:crypto';

export const IMMUTABLE_OBJECT_SET_PROTOCOL = 'devbridge/immutable-object-set-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const SAFE_LEAF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_OBJECTS = 8192;
const MAX_CHUNKS = 65536;
const MAX_OBJECT_CHUNKS = 16384;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function safeLeaf(value, name) {
  if (typeof value !== 'string' || value === '.' || value === '..' || !SAFE_LEAF.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function nonnegative(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
  return value;
}

function digest(value, name) {
  const normalized = String(value ?? '').toLowerCase();
  if (!SHA256.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function normalizeChunks(raw, context, objectSize) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OBJECT_CHUNKS) {
    throw new TypeError(`${context}.chunks are invalid`);
  }
  const names = new Set();
  let expectedOffset = 0;
  const chunks = raw.map((rawChunk, index) => {
    const name = `${context}.chunks[${index}]`;
    const value = requireObject(rawChunk, name);
    onlyKeys(value, new Set(['ordinal', 'name', 'offset', 'size', 'sha256']), name);
    if (value.ordinal !== index) throw new TypeError('immutable object chunk ordinals must be contiguous and ordered');
    const chunkName = safeLeaf(value.name, `${name}.name`);
    if (names.has(chunkName)) throw new TypeError('immutable object chunk names must be unique within an object');
    names.add(chunkName);
    const offset = nonnegative(value.offset, `${name}.offset`);
    if (offset !== expectedOffset) throw new TypeError('immutable object chunks must provide contiguous object coverage');
    const size = positive(value.size, `${name}.size`);
    if (size > Number.MAX_SAFE_INTEGER - expectedOffset) throw new RangeError('immutable object chunk coverage exceeds safe integer range');
    expectedOffset += size;
    return Object.freeze({ ordinal: index, name: chunkName, offset, size, sha256: digest(value.sha256, `${name}.sha256`) });
  });
  if (expectedOffset !== objectSize) throw new TypeError('immutable object chunks do not exactly cover the object');
  return Object.freeze(chunks);
}

export function normalizeImmutableObject(raw, { context = 'immutable object' } = {}) {
  if (typeof context !== 'string' || context.length < 1 || context.length > 160) throw new TypeError('immutable object context is invalid');
  const value = requireObject(raw, context);
  onlyKeys(value, new Set(['name', 'size', 'sha256', 'chunks']), context);
  const size = positive(value.size, `${context}.size`);
  return Object.freeze({
    name: safeLeaf(value.name, `${context}.name`),
    size,
    sha256: digest(value.sha256, `${context}.sha256`),
    chunks: normalizeChunks(value.chunks, context, size),
  });
}

export function normalizeImmutableObjectSet(raw) {
  const value = requireObject(raw, 'immutable object set');
  onlyKeys(value, new Set(['protocol', 'subject', 'objects']), 'immutable object set');
  if (value.protocol !== IMMUTABLE_OBJECT_SET_PROTOCOL) throw new TypeError('immutable object set protocol is unsupported');
  if (!Array.isArray(value.objects) || value.objects.length < 1 || value.objects.length > MAX_OBJECTS) {
    throw new TypeError('immutable object set objects are invalid');
  }
  let chunkCount = 0;
  const objects = value.objects.map((object, index) => {
    const normalized = normalizeImmutableObject(object, { context: `immutable object set objects[${index}]` });
    chunkCount += normalized.chunks.length;
    if (chunkCount > MAX_CHUNKS) throw new TypeError('immutable object set has too many chunks');
    return normalized;
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (new Set(objects.map((entry) => entry.name)).size !== objects.length) throw new TypeError('immutable object names must be unique');
  const sizes = new Map();
  for (const object of objects) {
    const previous = sizes.get(object.sha256);
    if (previous != null && previous !== object.size) throw new TypeError('immutable object digest has inconsistent sizes');
    sizes.set(object.sha256, object.size);
  }
  return Object.freeze({
    protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
    subject: safeId(value.subject, 'immutable object set subject'),
    objects: Object.freeze(objects),
  });
}

export function serializeImmutableObjectSet(raw) {
  return `${JSON.stringify(normalizeImmutableObjectSet(raw))}\n`;
}

export function immutableObjectSetDigest(raw) {
  return createHash('sha256').update(serializeImmutableObjectSet(raw), 'utf8').digest('hex');
}
