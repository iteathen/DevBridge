import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  immutableObjectSetDigest,
  normalizeImmutableObjectSet,
} from './immutable-object-set.js';
import {
  sameFilesystemIdentity,
  sameObservedFilesystemIdentity,
} from './local-filesystem-identity.js';

const READ_BYTES = 4 * 1024 * 1024;

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function signalShape(signal) {
  if (signal != null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError('immutable-object acquisition evidence signal is invalid');
  }
  return signal ?? null;
}

function interrupted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('immutable-object acquisition evidence observation was interrupted');
}

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function observeObject(raw, expected, signal, index) {
  const value = exactObject(raw, new Set(['name', 'size', 'sha256', 'location']), `immutable-object acquisition evidence object ${index}`);
  if (value.name !== expected.name || value.size !== expected.size || value.sha256 !== expected.sha256) {
    fail('immutable-object acquisition object evidence does not match authority');
  }
  if (typeof value.location !== 'string' || !path.isAbsolute(value.location)
      || /[\u0000-\u001f\u007f]/u.test(value.location)) {
    throw new TypeError('immutable-object acquisition object location is invalid');
  }
  const location = path.resolve(value.location);
  const canonical = await realpath(location);
  if (!await sameFilesystemIdentity(location, canonical)) {
    fail('immutable-object acquisition object must use a direct nonsymbolic path');
  }
  const before = await lstat(location, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail('immutable-object acquisition object must be one unlinked regular file');
  }
  if (before.size !== BigInt(expected.size)) fail('immutable-object acquisition object shape does not match authority');
  interrupted(signal);
  const handle = await open(location, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) {
      fail('immutable-object acquisition object changed while opening');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, expected.size));
    let offset = 0;
    while (offset < expected.size) {
      interrupted(signal);
      const requested = Math.min(buffer.length, expected.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead !== requested) fail('immutable-object acquisition object ended while reading');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      fail('immutable-object acquisition object grew while reading');
    }
    const after = await lstat(location, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(held, after)) {
      fail('immutable-object acquisition object changed while reading');
    }
    if (hash.digest('hex') !== expected.sha256) {
      fail('immutable-object acquisition object digest does not match authority');
    }
    return Object.freeze({ name: expected.name, size: expected.size, sha256: expected.sha256, location });
  } finally { await handle.close(); }
}

export async function reobserveExactFile(raw = {}) {
  const value = exactObject(raw, new Set(['location', 'size', 'sha256', 'signal']), 'exact file observation');
  if (!Number.isSafeInteger(value.size) || value.size < 1 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new TypeError('exact file observation identity is invalid');
  }
  const signal = signalShape(value.signal);
  interrupted(signal);
  const expected = { name: 'file', size: value.size, sha256: value.sha256 };
  const observed = await observeObject({ ...expected, location: value.location }, expected, signal, 0);
  return Object.freeze({ location: observed.location, size: observed.size, sha256: observed.sha256 });
}

export async function reobserveImmutableObjectAcquisition(raw = {}) {
  const request = exactObject(raw, new Set(['descriptor', 'evidence', 'signal']), 'immutable-object acquisition evidence request');
  const descriptor = normalizeImmutableObjectSet(request.descriptor);
  const descriptorSha256 = immutableObjectSetDigest(descriptor);
  const evidence = exactObject(request.evidence, new Set([
    'state', 'subject', 'descriptorSha256', 'objects', 'sourceAttempts', 'reusedChunks',
  ]), 'immutable-object acquisition evidence');
  const signal = signalShape(request.signal);
  interrupted(signal);
  if (!['cached', 'cache-committed'].includes(evidence.state)
      || evidence.subject !== descriptor.subject || evidence.descriptorSha256 !== descriptorSha256) {
    fail('immutable-object acquisition descriptor evidence does not match authority');
  }
  if (!Number.isSafeInteger(evidence.sourceAttempts) || evidence.sourceAttempts < 0
      || !Number.isSafeInteger(evidence.reusedChunks) || evidence.reusedChunks < 0
      || !Array.isArray(evidence.objects) || evidence.objects.length !== descriptor.objects.length) {
    fail('immutable-object acquisition result evidence is invalid');
  }
  const objects = [];
  for (let index = 0; index < descriptor.objects.length; index += 1) {
    objects.push(await observeObject(evidence.objects[index], descriptor.objects[index], signal, index));
  }
  return Object.freeze({
    state: evidence.state,
    subject: descriptor.subject,
    descriptorSha256,
    objects: Object.freeze(objects),
    sourceAttempts: evidence.sourceAttempts,
    reusedChunks: evidence.reusedChunks,
  });
}
