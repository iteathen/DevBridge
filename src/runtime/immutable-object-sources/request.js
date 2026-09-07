import {
  IMMUTABLE_OBJECT_SET_PROTOCOL,
  normalizeImmutableObjectSet,
} from '../immutable-object-set.js';

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function sameChunk(left, right) {
  return left.ordinal === right.ordinal
    && left.name === right.name
    && left.offset === right.offset
    && left.size === right.size
    && left.sha256 === right.sha256;
}

export function normalizeImmutableObjectSourceRequest(raw) {
  const value = requireObject(raw, 'immutable object source request');
  onlyKeys(value, new Set(['subject', 'object', 'chunk', 'signal']), 'immutable object source request');
  const descriptor = normalizeImmutableObjectSet({
    protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
    subject: value.subject,
    objects: [value.object],
  });
  const object = descriptor.objects[0];
  const suppliedChunk = requireObject(value.chunk, 'immutable object source request.chunk');
  onlyKeys(suppliedChunk, new Set(['ordinal', 'name', 'offset', 'size', 'sha256']), 'immutable object source request.chunk');
  const chunk = object.chunks[suppliedChunk.ordinal];
  if (!chunk || !sameChunk(chunk, suppliedChunk)) throw new TypeError('immutable object source chunk does not belong to its object');
  if (value.signal != null && (typeof value.signal !== 'object'
      || typeof value.signal.aborted !== 'boolean'
      || typeof value.signal.addEventListener !== 'function'
      || typeof value.signal.removeEventListener !== 'function')) {
    throw new TypeError('immutable object source signal is invalid');
  }
  return Object.freeze({ subject: descriptor.subject, object, chunk, signal: value.signal ?? null });
}

export function immutableObjectSourceAbort(signal) {
  if (!signal?.aborted) return;
  const error = new Error('immutable object source was interrupted', { cause: signal.reason });
  error.name = 'AbortError';
  throw error;
}
