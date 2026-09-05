import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { sameFilesystemIdentity, sameObservedFilesystemIdentity } from './local-filesystem-identity.js';
import {
  immutableObjectSetDigest,
  normalizeImmutableObjectSet,
} from './immutable-object-set.js';

export const IMMUTABLE_OBJECT_ACQUISITION_PROTOCOL = 'devbridge/immutable-object-acquisition-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const STATES = Object.freeze(['planned', 'acquiring', 'object-complete', 'verified', 'cache-committed']);
const STATE_BYTES = 1024 * 1024;
const COPY_BYTES = 4 * 1024 * 1024;
const SOURCE_ATTEMPT_FAILURE = Symbol('immutable-object-source-attempt-failure');

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function requireRealDirectory(directory) {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('immutable object acquisition directory must be a real directory');
  const canonical = await realpath(directory);
  if (!await sameFilesystemIdentity(directory, canonical)) throw new Error('immutable object acquisition directory uses filesystem indirection');
  return directory;
}

async function ensureRealDirectory(directory) {
  try { await mkdir(directory, { recursive: true, mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  return requireRealDirectory(directory);
}

async function optionalRealDirectory(directory) {
  try { return await requireRealDirectory(directory); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function measureRegularFile(location, expectedSize = null) {
  let before;
  try { before = await lstat(location, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('immutable object cache entry has an unsafe file shape');
  if (expectedSize != null && before.size !== BigInt(expectedSize)) {
    return Object.freeze({ size: null, sha256: null });
  }
  const handle = await open(location, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) throw new Error('immutable object cache entry changed while opening');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BYTES);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await lstat(location, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(held, after)) {
      throw new Error('immutable object cache entry changed during verification');
    }
    return Object.freeze({ size: offset, sha256: hash.digest('hex') });
  } finally { await handle.close(); }
}

async function verifiedFile(location, expected) {
  const measured = await measureRegularFile(location, expected.size);
  return measured != null && measured.size === expected.size && measured.sha256 === expected.sha256;
}

function initialJournal(descriptor, descriptorSha256) {
  return Object.freeze({
    protocol: IMMUTABLE_OBJECT_ACQUISITION_PROTOCOL,
    subject: descriptor.subject,
    descriptorSha256,
    revision: 0,
    objects: Object.freeze(descriptor.objects.map((object) => Object.freeze({ name: object.name, sha256: object.sha256, state: 'planned' }))),
  });
}

function normalizeJournal(raw, descriptor, descriptorSha256) {
  const value = requireObject(raw, 'immutable object acquisition journal');
  onlyKeys(value, new Set(['protocol', 'subject', 'descriptorSha256', 'revision', 'objects']), 'immutable object acquisition journal');
  if (value.protocol !== IMMUTABLE_OBJECT_ACQUISITION_PROTOCOL) throw new Error('immutable object acquisition journal protocol is unsupported');
  if (value.subject !== descriptor.subject || value.descriptorSha256 !== descriptorSha256) throw new Error('immutable object acquisition journal belongs to another subject');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('immutable object acquisition journal revision is invalid');
  if (!Array.isArray(value.objects) || value.objects.length !== descriptor.objects.length) throw new Error('immutable object acquisition journal object inventory changed');
  const objects = value.objects.map((rawObject, index) => {
    const entry = requireObject(rawObject, `immutable object acquisition journal.objects[${index}]`);
    onlyKeys(entry, new Set(['name', 'sha256', 'state']), `immutable object acquisition journal.objects[${index}]`);
    const expected = descriptor.objects[index];
    if (entry.name !== expected.name || entry.sha256 !== expected.sha256) throw new Error('immutable object acquisition journal object identity changed');
    if (!STATES.includes(entry.state)) throw new Error('immutable object acquisition journal state is invalid');
    return Object.freeze({ name: entry.name, sha256: entry.sha256, state: entry.state });
  });
  return Object.freeze({ ...value, objects: Object.freeze(objects) });
}

async function readJournal(location, descriptor, descriptorSha256) {
  let before;
  try { before = await lstat(location, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return initialJournal(descriptor, descriptorSha256); throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(STATE_BYTES)) {
    throw new Error('immutable object acquisition journal has an unsafe file shape');
  }
  const handle = await open(location, 'r');
  let bytes;
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) {
      throw new Error('immutable object acquisition journal changed while opening');
    }
    bytes = Buffer.alloc(Number(held.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('immutable object acquisition journal ended while reading');
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      throw new Error('immutable object acquisition journal grew while reading');
    }
    const after = await lstat(location, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(held, after)) {
      throw new Error('immutable object acquisition journal changed while reading');
    }
  } finally { await handle.close(); }
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('immutable object acquisition journal is invalid JSON'); }
  return normalizeJournal(parsed, descriptor, descriptorSha256);
}

async function writeJournal(directory, location, journal) {
  const next = Object.freeze({ ...journal, revision: journal.revision + 1 });
  const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, location); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
  return next;
}

async function removeOwnedTemps(directory, pattern) {
  for (const name of await readdir(directory)) {
    if (!pattern.test(name)) continue;
    const location = path.join(directory, name);
    const info = await lstat(location);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('immutable object temporary entry has an unsafe file shape');
    await unlink(location);
  }
}

async function removeCommittedChunks(directory, object) {
  if (await optionalRealDirectory(directory) == null) return;
  const expected = new Set(object.chunks.map((chunk) => `${String(chunk.ordinal).padStart(6, '0')}-${chunk.sha256}`));
  const names = await readdir(directory);
  if (names.some((name) => !expected.has(name))) throw new Error('immutable object chunk cleanup found an unexpected entry');
  for (const name of names) {
    const location = path.join(directory, name);
    const info = await lstat(location);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('immutable object chunk cleanup found an unsafe file shape');
    await unlink(location);
  }
  await rmdir(directory);
}

function withObjectState(journal, objectName, state) {
  if (!STATES.includes(state)) throw new TypeError('immutable object acquisition state is invalid');
  const objects = journal.objects.map((entry) => entry.name === objectName ? Object.freeze({ ...entry, state }) : entry);
  if (!objects.some((entry) => entry.name === objectName)) throw new Error('immutable object acquisition object is absent from its journal');
  return Object.freeze({ ...journal, objects: Object.freeze(objects) });
}

function requireBody(value) {
  const result = requireObject(value, 'immutable object source response');
  onlyKeys(result, new Set(['body']), 'immutable object source response');
  if (!result.body || typeof result.body[Symbol.asyncIterator] !== 'function') throw new Error('immutable object source body is invalid');
  return result.body;
}

function sourceAttemptFailure(error) {
  const wrapped = new Error('immutable object byte source failed', { cause: error });
  if (typeof error?.name === 'string') wrapped.name = error.name;
  wrapped[SOURCE_ATTEMPT_FAILURE] = true;
  return wrapped;
}

async function releaseIterator(iterator) {
  if (typeof iterator.return === 'function') await Promise.resolve().then(() => iterator.return()).catch(() => {});
}

function aborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('immutable object acquisition was interrupted', { cause: signal.reason });
  error.name = 'AbortError';
  throw error;
}

async function writeSourceAttempt({ source, request, destination, signal }) {
  aborted(signal);
  let body;
  let iterator;
  try {
    body = requireBody(await source.fetch({ ...request, signal }));
    iterator = body[Symbol.asyncIterator]();
    if (!iterator || typeof iterator.next !== 'function') throw new Error('immutable object source body iterator is invalid');
  }
  catch (error) { throw sourceAttemptFailure(error); }
  let handle;
  try { handle = await open(destination, 'wx', 0o600); }
  catch (error) { await releaseIterator(iterator); throw error; }
  const hash = createHash('sha256');
  let size = 0;
  let failure = null;
  try {
    while (true) {
      aborted(signal);
      let step;
      try { step = await iterator.next(); }
      catch (error) { throw sourceAttemptFailure(error); }
      if (!step || typeof step.done !== 'boolean') {
        throw sourceAttemptFailure(new Error('immutable object source body iterator returned an invalid result'));
      }
      if (step.done) break;
      if (!(step.value instanceof Uint8Array)) {
        throw sourceAttemptFailure(new Error('immutable object source body yielded a non-byte value'));
      }
      const chunk = Buffer.from(step.value);
      if (chunk.length === 0) continue;
      if (chunk.length > request.chunk.size - size) {
        throw sourceAttemptFailure(new Error('immutable object source exceeded the exact chunk byte count'));
      }
      const { bytesWritten } = await handle.write(chunk, 0, chunk.length, size);
      if (bytesWritten !== chunk.length) throw new Error('immutable object source write was incomplete');
      hash.update(chunk);
      size += chunk.length;
    }
    aborted(signal);
    await handle.sync();
  } catch (error) {
    await releaseIterator(iterator);
    failure = error;
  }
  try { await handle.close(); }
  catch (error) { if (failure == null) failure = error; }
  if (failure == null && size !== request.chunk.size) {
    failure = sourceAttemptFailure(new Error('immutable object source did not provide the exact chunk byte count'));
  }
  if (failure == null && hash.digest('hex') !== request.chunk.sha256) {
    failure = sourceAttemptFailure(new Error('immutable object source chunk digest does not match authority'));
  }
  if (failure == null) return;
  await rm(destination, { force: true }).catch(() => {});
  throw failure;
}

async function acquireChunk({ sources, unavailableSources, descriptor, object, chunk, directory, signal }) {
  const final = path.join(directory, `${String(chunk.ordinal).padStart(6, '0')}-${chunk.sha256}`);
  if (await verifiedFile(final, chunk)) return Object.freeze({ location: final, reused: true, attempts: 0 });
  try {
    const existing = await lstat(final);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('immutable object retained chunk has an unsafe file shape');
    await rm(final);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let attempts = 0;
  for (const source of sources) {
    if (unavailableSources.has(source)) continue;
    attempts += 1;
    const temporary = path.join(directory, `.download-${randomUUID()}.tmp`);
    try {
      await writeSourceAttempt({ source, request: { subject: descriptor.subject, object, chunk }, destination: temporary, signal });
      await rename(temporary, final);
      return Object.freeze({ location: final, reused: false, attempts });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.[SOURCE_ATTEMPT_FAILURE] !== true) throw error;
      unavailableSources.add(source);
    }
  }
  const error = new Error(`immutable object is unavailable: ${object.name} chunk ${chunk.ordinal} after ${attempts} source attempt(s)`);
  error.code = 'IMMUTABLE_OBJECT_UNAVAILABLE';
  error.subject = descriptor.subject;
  error.object = object.name;
  error.chunk = chunk.ordinal;
  error.attempts = attempts;
  throw error;
}

async function assembleObject(chunks, destination, expected) {
  const output = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BYTES);
  let outputOffset = 0;
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const authority = expected.chunks[index];
      if (!await verifiedFile(chunk, authority)) throw new Error('immutable object retained chunk changed before assembly');
      const input = await open(chunk, 'r');
      try {
        let inputOffset = 0;
        while (inputOffset < authority.size) {
          const requested = Math.min(buffer.length, authority.size - inputOffset);
          const { bytesRead } = await input.read(buffer, 0, requested, inputOffset);
          if (bytesRead !== requested) throw new Error('immutable object retained chunk ended during assembly');
          const bytes = buffer.subarray(0, bytesRead);
          const { bytesWritten } = await output.write(bytes, 0, bytes.length, outputOffset);
          if (bytesWritten !== bytes.length) throw new Error('immutable object assembly write was incomplete');
          hash.update(bytes);
          inputOffset += bytesRead;
          outputOffset += bytesRead;
        }
      } finally { await input.close(); }
    }
    await output.sync();
  } finally { await output.close(); }
  if (outputOffset !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error('complete immutable object failed verification');
}

export class ImmutableObjectAcquisition {
  #directory;
  #sources;
  #tail = Promise.resolve();

  constructor({ directory, sources } = {}) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0')) throw new TypeError('immutable object acquisition directory is invalid');
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 16
        || sources.some((source) => !source || typeof source.fetch !== 'function')) {
      throw new TypeError('immutable object sources are invalid');
    }
    this.#directory = path.resolve(directory);
    this.#sources = Object.freeze([...sources]);
  }

  #serial(work) {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => {});
    return next;
  }

  async #ensureUnlocked({ descriptor: rawDescriptor, signal = null } = {}) {
    if (signal != null && typeof signal !== 'object') throw new TypeError('immutable object acquisition signal is invalid');
    aborted(signal);
    const descriptor = normalizeImmutableObjectSet(rawDescriptor);
    const descriptorSha256 = immutableObjectSetDigest(descriptor);
    const objectRoot = await ensureRealDirectory(path.join(this.#directory, 'objects'));
    const workRoot = await ensureRealDirectory(path.join(this.#directory, 'work', descriptorSha256));
    const stateRoot = await ensureRealDirectory(path.join(this.#directory, 'transactions', descriptorSha256));
    await removeOwnedTemps(stateRoot, /^\.state-[a-f0-9-]{36}\.tmp$/u);
    const stateFile = path.join(stateRoot, 'state.json');
    let journal = await readJournal(stateFile, descriptor, descriptorSha256);
    if (journal.revision === 0) journal = await writeJournal(stateRoot, stateFile, journal);
    const results = [];
    let sourceAttempts = 0;
    let reusedChunks = 0;
    let allCached = true;
    const unavailableSources = new Set();

    for (const object of descriptor.objects) {
      aborted(signal);
      const cached = path.join(objectRoot, object.sha256);
      await removeOwnedTemps(workRoot, new RegExp(`^\\.object-${object.sha256}-[a-f0-9-]{36}\\.tmp$`, 'u'));
      if (await verifiedFile(cached, object)) {
        if (journal.objects.find((entry) => entry.name === object.name)?.state !== 'cache-committed') {
          journal = await writeJournal(stateRoot, stateFile, withObjectState(journal, object.name, 'cache-committed'));
        }
        await removeCommittedChunks(path.join(workRoot, object.sha256), object);
        results.push(Object.freeze({ name: object.name, size: object.size, sha256: object.sha256, location: cached }));
        continue;
      }
      try {
        const existing = await lstat(cached);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('immutable object cache entry has an unsafe file shape');
        throw new Error('immutable object cache entry failed exact verification');
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }

      allCached = false;
      journal = await writeJournal(stateRoot, stateFile, withObjectState(journal, object.name, 'acquiring'));
      const chunkRoot = await ensureRealDirectory(path.join(workRoot, object.sha256));
      await removeOwnedTemps(chunkRoot, /^\.download-[a-f0-9-]{36}\.tmp$/u);
      const chunks = [];
      for (const chunk of object.chunks) {
        const acquired = await acquireChunk({ sources: this.#sources, unavailableSources, descriptor, object, chunk, directory: chunkRoot, signal });
        chunks.push(acquired.location);
        sourceAttempts += acquired.attempts;
        if (acquired.reused) reusedChunks += 1;
      }
      journal = await writeJournal(stateRoot, stateFile, withObjectState(journal, object.name, 'object-complete'));
      const assembled = path.join(workRoot, `.object-${object.sha256}-${randomUUID()}.tmp`);
      try {
        await assembleObject(chunks, assembled, object);
        journal = await writeJournal(stateRoot, stateFile, withObjectState(journal, object.name, 'verified'));
        await rename(assembled, cached);
      } catch (error) {
        await rm(assembled, { force: true }).catch(() => {});
        throw error;
      }
      if (!await verifiedFile(cached, object)) throw new Error('committed immutable object did not verify');
      journal = await writeJournal(stateRoot, stateFile, withObjectState(journal, object.name, 'cache-committed'));
      await removeCommittedChunks(chunkRoot, object);
      results.push(Object.freeze({ name: object.name, size: object.size, sha256: object.sha256, location: cached }));
    }

    return Object.freeze({
      state: allCached ? 'cached' : 'cache-committed',
      subject: descriptor.subject,
      descriptorSha256,
      objects: Object.freeze(results),
      sourceAttempts,
      reusedChunks,
    });
  }

  ensure(input) { return this.#serial(() => this.#ensureUnlocked(input)); }

  async #observeUnlocked({ descriptor: rawDescriptor } = {}) {
    const descriptor = normalizeImmutableObjectSet(rawDescriptor);
    const descriptorSha256 = immutableObjectSetDigest(descriptor);
    const objectRoot = path.join(this.#directory, 'objects');
    const exists = await optionalRealDirectory(objectRoot) != null;
    const objects = [];
    for (const object of descriptor.objects) {
      const location = path.join(objectRoot, object.sha256);
      const measured = exists ? await measureRegularFile(location, object.size) : null;
      const state = measured == null
        ? 'absent'
        : measured.size === object.size && measured.sha256 === object.sha256 ? 'available' : 'invalid';
      objects.push(Object.freeze({ name: object.name, size: object.size, sha256: object.sha256, state }));
    }
    return Object.freeze({
      state: objects.every((object) => object.state === 'available') ? 'available' : 'unavailable',
      ready: objects.every((object) => object.state === 'available'),
      subject: descriptor.subject,
      descriptorSha256,
      objects: Object.freeze(objects),
    });
  }

  observe(input) { return this.#serial(() => this.#observeUnlocked(input)); }
}
