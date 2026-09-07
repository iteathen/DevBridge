import { createHash } from 'node:crypto';
import path from 'node:path';
import { reobserveImmutableObjectAcquisition } from '../runtime/immutable-object-acquisition-evidence.js';
import {
  IMMUTABLE_OBJECT_SET_PROTOCOL,
  immutableObjectSetDigest,
  normalizeImmutableObjectSet,
} from '../runtime/immutable-object-set.js';

export const IMMUTABLE_RELEASE_PUBLICATION_PROTOCOL = 'devbridge/immutable-release-publication-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const SAFE_LEAF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_DESCRIPTORS = 32;
const MAX_OBJECTS = 16_384;
const MAX_AUTHORITY_ITEMS = 32;
const MAX_AUTHORITY_BYTES = 16 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function signalShape(signal) {
  if (signal != null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError('immutable release publication signal is invalid');
  }
  return signal ?? null;
}

function interrupted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('immutable release publication was interrupted');
}

function method(value, owner, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} is invalid`);
  return value.bind(owner);
}

function destination(raw, index) {
  const value = exactObject(raw, new Set(['identity', 'objects', 'source', 'authority']), `immutable release destination ${index}`);
  if (typeof value.identity !== 'string' || !SAFE_ID.test(value.identity)) {
    throw new TypeError(`immutable release destination ${index} identity is invalid`);
  }
  const objects = exactObject(value.objects, new Set(['ensure']), `immutable release destination ${index} object publication`);
  const source = exactObject(value.source, new Set(['fetch']), `immutable release destination ${index} object source`);
  const authority = exactObject(value.authority, new Set(['ensure', 'read']), `immutable release destination ${index} authority publication`);
  return Object.freeze({
    identity: value.identity,
    ensureObject: method(objects.ensure, objects, `immutable release destination ${index} object publication port`),
    fetchObject: method(source.fetch, source, `immutable release destination ${index} object source port`),
    ensureAuthority: method(authority.ensure, authority, `immutable release destination ${index} authority publication port`),
    readAuthority: method(authority.read, authority, `immutable release destination ${index} authority read port`),
  });
}

function descriptors(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_DESCRIPTORS) {
    throw new TypeError('immutable release publication descriptors are invalid');
  }
  const values = raw.map((value) => normalizeImmutableObjectSet(value));
  const digests = values.map(immutableObjectSetDigest);
  if (new Set(digests).size !== digests.length
      || new Set(values.map((value) => value.subject)).size !== values.length) {
    fail('immutable release publication descriptors must be unique');
  }
  return Object.freeze(values);
}

function expectedObjects(values) {
  const byDigest = new Map();
  for (const descriptor of values) {
    for (const object of descriptor.objects) {
      for (const chunk of object.chunks) {
        const current = byDigest.get(chunk.sha256);
        if (current != null && current.size !== chunk.size) fail('immutable release publication descriptor chunk identity is inconsistent');
        if (current == null) byDigest.set(chunk.sha256, Object.freeze({
          sha256: chunk.sha256,
          size: chunk.size,
          descriptor,
          object,
          chunk,
        }));
      }
    }
  }
  if (byDigest.size < 1 || byDigest.size > MAX_OBJECTS) fail('immutable release publication descriptor object coverage is invalid');
  return Object.freeze([...byDigest.values()].sort((left, right) => left.sha256.localeCompare(right.sha256)));
}

async function localObjects(raw, expected, signal) {
  if (!Array.isArray(raw) || raw.length !== expected.length) fail('immutable release publication object coverage is invalid');
  const supplied = new Map();
  for (let index = 0; index < raw.length; index += 1) {
    const item = exactObject(raw[index], new Set(['sha256', 'size', 'location']), `immutable release publication object ${index}`);
    if (typeof item.sha256 !== 'string' || !DIGEST.test(item.sha256) || supplied.has(item.sha256)
        || !Number.isSafeInteger(item.size) || item.size < 1
        || typeof item.location !== 'string' || !path.isAbsolute(item.location)) {
      fail('immutable release publication object coverage is invalid');
    }
    supplied.set(item.sha256, item);
  }
  if (expected.some((item) => supplied.get(item.sha256)?.size !== item.size)) {
    fail('immutable release publication object coverage is invalid');
  }
  const inputDescriptor = normalizeImmutableObjectSet({
    protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
    subject: 'immutable-release-publication-input',
    objects: expected.map((item, index) => ({
      name: `object-${String(index).padStart(5, '0')}`,
      size: item.size,
      sha256: item.sha256,
      chunks: [{
        ordinal: 0,
        name: `object-${String(index).padStart(5, '0')}.000000`,
        offset: 0,
        size: item.size,
        sha256: item.sha256,
      }],
    })),
  });
  const evidence = {
    state: 'cached',
    subject: inputDescriptor.subject,
    descriptorSha256: immutableObjectSetDigest(inputDescriptor),
    objects: inputDescriptor.objects.map((object, index) => ({
      name: object.name,
      size: object.size,
      sha256: object.sha256,
      location: supplied.get(expected[index].sha256).location,
    })),
    sourceAttempts: 0,
    reusedChunks: expected.length,
  };
  return (await reobserveImmutableObjectAcquisition({ descriptor: inputDescriptor, evidence, signal })).objects
    .map((object, index) => Object.freeze({
      sha256: expected[index].sha256,
      size: expected[index].size,
      location: object.location,
      descriptor: expected[index].descriptor,
      object: expected[index].object,
      chunk: expected[index].chunk,
    }));
}

function authorityItem(raw, name) {
  const value = exactObject(raw, new Set(['name', 'bytes']), name);
  if (typeof value.name !== 'string' || !SAFE_LEAF.test(value.name)
      || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 1
      || value.bytes.byteLength > MAX_AUTHORITY_BYTES) {
    throw new TypeError(`${name} is invalid`);
  }
  const bytes = Buffer.from(value.bytes);
  return Object.freeze({ name: value.name, bytes, size: bytes.length, sha256: sha256(bytes) });
}

function authority(rawPrerequisites, rawCommit) {
  if (!Array.isArray(rawPrerequisites) || rawPrerequisites.length < 1
      || rawPrerequisites.length > MAX_AUTHORITY_ITEMS) {
    throw new TypeError('immutable release authority prerequisites are invalid');
  }
  const prerequisites = rawPrerequisites.map((item, index) => authorityItem(item, `immutable release authority prerequisite ${index}`));
  const commit = authorityItem(rawCommit, 'immutable release authority commit');
  const names = [...prerequisites.map((item) => item.name), commit.name];
  if (new Set(names).size !== names.length) fail('immutable release authority names must be unique');
  return Object.freeze({ prerequisites: Object.freeze(prerequisites), commit });
}

async function verifyAuthority(target, item, signal) {
  interrupted(signal);
  const raw = await target.readAuthority({ name: item.name, size: item.size, sha256: item.sha256, signal });
  if (!(raw instanceof Uint8Array)) fail('immutable release authority read-back is invalid');
  const bytes = Buffer.from(raw);
  if (bytes.length !== item.size || sha256(bytes) !== item.sha256) {
    fail('immutable release authority read-back does not match publication');
  }
}

async function verifyObject(target, item, signal) {
  interrupted(signal);
  const response = exactObject(await target.fetchObject({
    subject: item.descriptor.subject,
    object: item.object,
    chunk: item.chunk,
    signal,
  }), new Set(['body']), 'immutable release object source response');
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    fail('immutable release object source body is invalid');
  }
  const iterator = response.body[Symbol.asyncIterator]();
  if (!iterator || typeof iterator.next !== 'function') fail('immutable release object source iterator is invalid');
  const hash = createHash('sha256');
  let size = 0;
  let complete = false;
  try {
    while (true) {
      interrupted(signal);
      const step = await iterator.next();
      if (!step || typeof step.done !== 'boolean') fail('immutable release object source iterator returned an invalid result');
      if (step.done) { complete = true; break; }
      if (!(step.value instanceof Uint8Array)) fail('immutable release object source yielded a non-byte value');
      const bytes = Buffer.from(step.value);
      if (bytes.length > item.size - size) fail('immutable release object source exceeded the exact byte count');
      hash.update(bytes);
      size += bytes.length;
    }
  } finally {
    if (!complete && typeof iterator.return === 'function') await Promise.resolve().then(() => iterator.return()).catch(() => {});
  }
  if (size !== item.size || hash.digest('hex') !== item.sha256) {
    fail('immutable release object read-back does not match publication');
  }
}

export class ImmutableReleasePublicationGate {
  #destinations;

  constructor(raw = {}) {
    const value = exactObject(raw, new Set(['destinations']), 'immutable release publication options');
    if (!Array.isArray(value.destinations) || value.destinations.length < 1 || value.destinations.length > 16) {
      throw new TypeError('immutable release publication destinations are invalid');
    }
    const selected = value.destinations.map(destination);
    if (new Set(selected.map((item) => item.identity)).size !== selected.length) {
      fail('immutable release destination identities must be unique');
    }
    this.#destinations = Object.freeze(selected);
  }

  async publish(raw = {}) {
    const request = exactObject(raw, new Set([
      'descriptors', 'objects', 'authorityPrerequisites', 'authorityCommit', 'signal',
    ]), 'immutable release publication request');
    const signal = signalShape(request.signal);
    interrupted(signal);
    const selectedDescriptors = descriptors(request.descriptors);
    const descriptorSha256s = Object.freeze(selectedDescriptors.map(immutableObjectSetDigest));
    const expected = expectedObjects(selectedDescriptors);
    const selectedObjects = await localObjects(request.objects, expected, signal);
    const selectedAuthority = authority(request.authorityPrerequisites, request.authorityCommit);
    const receipts = [];

    for (const target of this.#destinations) {
      for (const object of selectedObjects) {
        interrupted(signal);
        await target.ensureObject({ sha256: object.sha256, size: object.size, location: object.location, signal });
      }
      for (const object of selectedObjects) await verifyObject(target, object, signal);
      receipts.push({ identity: target.identity });
    }

    for (const item of selectedAuthority.prerequisites) {
      for (const target of this.#destinations) {
        interrupted(signal);
        await target.ensureAuthority({ ...item, bytes: Buffer.from(item.bytes), signal });
        await verifyAuthority(target, item, signal);
      }
    }
    for (const target of this.#destinations) {
      interrupted(signal);
      await target.ensureAuthority({ ...selectedAuthority.commit, bytes: Buffer.from(selectedAuthority.commit.bytes), signal });
      await verifyAuthority(target, selectedAuthority.commit, signal);
    }

    return Object.freeze({
      protocol: IMMUTABLE_RELEASE_PUBLICATION_PROTOCOL,
      descriptorSha256s,
      objectSha256s: Object.freeze(expected.map((item) => item.sha256)),
      authorityPrerequisiteSha256s: Object.freeze(selectedAuthority.prerequisites.map((item) => item.sha256)),
      authorityCommitSha256: selectedAuthority.commit.sha256,
      destinations: Object.freeze(receipts.map((receipt) => Object.freeze(receipt))),
    });
  }
}
