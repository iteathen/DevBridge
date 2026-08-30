import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { link, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as pause } from 'node:timers/promises';

export const EXACT_ARTIFACT_RECEIPT_PROTOCOL = 'devbridge/exact-artifact-receipt-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION_FILE = /^(\d{12})\.json$/u;
const PROVENANCE = new Set(['created', 'adopted']);
const MAX_REVISIONS = 100_000;
const MAX_ITEMS = 4_096;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_VALUE_NODES = 100_000;
const MAX_VALUE_DEPTH = 64;
const MAX_ATTEMPTS = 16;
const LINK_SETTLE_ATTEMPTS = 16;
const LINK_SETTLE_DELAY_MS = 5;

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function identity(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function freeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) freeze(entry);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
  }
  return Object.freeze(value);
}

function exactJson(raw, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  const seen = new WeakSet();
  let nodes = 0;
  function visit(value, depth) {
    nodes += 1;
    if (nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) fail(`${name} exceeds its structural bound`);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(`${name} contains a non-finite number`);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) fail(`${name} is not exact JSON data`);
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail(`${name} is not exact JSON data`);
    seen.add(value);
    for (const entry of Array.isArray(value) ? value : Object.values(value)) visit(entry, depth + 1);
    seen.delete(value);
  }
  try {
    visit(raw, 0);
    const selected = canonical(structuredClone(raw));
    const encoded = JSON.stringify(selected);
    if (encoded == null || Buffer.byteLength(encoded, 'utf8') > MAX_RECORD_BYTES) fail(`${name} exceeds its byte bound`);
    return freeze(selected);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(name)) throw error;
    if (typeof error?.message === 'string' && error.message.startsWith(name)) {
      throw new TypeError(error.message, { cause: error });
    }
    throw new TypeError(`${name} must be bounded exact JSON data`, { cause: error });
  }
}

function normalizeItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) throw new TypeError('artifact receipt items are invalid');
  const items = raw.map((entry, index) => {
    const value = exactObject(entry, new Set(['identity', 'provenance', 'value']), `artifact receipt item ${index}`);
    if (!PROVENANCE.has(value.provenance)) throw new TypeError(`artifact receipt item ${index}.provenance is invalid`);
    return Object.freeze({
      identity: identity(value.identity, `artifact receipt item ${index}.identity`),
      provenance: value.provenance,
      value: exactJson(value.value, `artifact receipt item ${index}.value`),
    });
  }).sort((left, right) => left.identity.localeCompare(right.identity));
  if (new Set(items.map((entry) => entry.identity)).size !== items.length) throw new TypeError('artifact receipt items contain duplicates');
  return Object.freeze(items);
}

function normalizeComparison(raw) {
  const value = exactObject(raw, new Set(['generation', 'items']), 'artifact receipt comparison');
  if (value.generation != null
      && (typeof value.generation !== 'string' || !/^generation-[0-9a-f]{64}$/u.test(value.generation))) {
    throw new TypeError('artifact receipt comparison.generation is invalid');
  }
  return Object.freeze({ generation: value.generation ?? null, items: normalizeItems(value.items) });
}

function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function generation(epoch, revision, items) {
  return `generation-${digestBytes(Buffer.from(JSON.stringify(canonical({ epoch, revision, items })), 'utf8'))}`;
}

function normalizeRecord(raw, expectedRevision, expectedPreviousDigest) {
  const value = exactObject(
    raw,
    new Set(['protocol', 'revision', 'epoch', 'previousDigest', 'generation', 'items']),
    'artifact receipt record',
  );
  if (value.protocol !== EXACT_ARTIFACT_RECEIPT_PROTOCOL) fail('artifact receipt protocol is unsupported');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > MAX_REVISIONS
      || value.revision !== expectedRevision) fail('artifact receipt revision is invalid');
  if (typeof value.epoch !== 'string' || !UUID.test(value.epoch)) fail('artifact receipt epoch is invalid');
  if (value.previousDigest !== expectedPreviousDigest
      || (value.previousDigest != null && (typeof value.previousDigest !== 'string' || !SHA256.test(value.previousDigest)))) {
    fail('artifact receipt previous digest is invalid');
  }
  const items = normalizeItems(value.items);
  const expectedGeneration = generation(value.epoch, value.revision, items);
  if (value.generation !== expectedGeneration) fail('artifact receipt generation is invalid');
  return Object.freeze({
    protocol: EXACT_ARTIFACT_RECEIPT_PROTOCOL,
    revision: value.revision,
    epoch: value.epoch,
    previousDigest: value.previousDigest,
    generation: expectedGeneration,
    items,
  });
}

function encode(record) {
  return Buffer.from(`${JSON.stringify(canonical(record))}\n`, 'utf8');
}

function revisionName(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISIONS) fail('artifact receipt revision is out of range');
  return `${String(revision).padStart(12, '0')}.json`;
}

function comparable(location) {
  const resolved = path.resolve(location);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameObservedObject(left, right) {
  if (left.ino === 0n || left.ino !== right.ino) return false;
  if (process.platform === 'win32' && (left.dev === 0n || right.dev === 0n)) return true;
  return left.dev === right.dev;
}

async function containsSymbolicEntry(location) {
  const resolved = path.resolve(location);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if ((await lstat(current, { bigint: true })).isSymbolicLink()) return true;
  }
  return false;
}

async function sameDirectoryObject(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  const sameSpelling = comparable(a) === comparable(b);
  if (process.platform !== 'win32' && !sameSpelling) return false;
  if (comparable(path.parse(a).root) !== comparable(path.parse(b).root)) return false;
  if (await containsSymbolicEntry(a) || (!sameSpelling && await containsSymbolicEntry(b))) return false;
  if (sameSpelling) return true;
  const [aInfo, bInfo] = await Promise.all([lstat(a, { bigint: true }), lstat(b, { bigint: true })]);
  return aInfo.isDirectory() && bInfo.isDirectory() && !aInfo.isSymbolicLink() && !bInfo.isSymbolicLink()
    && sameObservedObject(aInfo, bInfo);
}

async function realDirectory(directory, { create = false } = {}) {
  if (create) {
    try { await lstat(directory); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(directory);
      if (parent === directory) fail('artifact receipt directory has no available real parent');
      await realDirectory(parent);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
    }
  }
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) fail('artifact receipt directory must be a real directory');
  const actual = await realpath(directory);
  if (!(await sameDirectoryObject(directory, actual))) fail('artifact receipt directory uses filesystem indirection');
  return path.resolve(actual);
}

function samePathObservation(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.birthtimeNs === right.birthtimeNs;
}

function sameHeldObservation(location, held) {
  if (!held.isFile() || held.nlink !== 1n || held.ino !== location.ino || held.size !== location.size) return false;
  return process.platform === 'win32' && (held.dev === 0n || location.dev === 0n) ? true : held.dev === location.dev;
}

async function exactFile(file) {
  let before;
  for (let attempt = 0; attempt < LINK_SETTLE_ATTEMPTS; attempt += 1) {
    before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(MAX_RECORD_BYTES)) {
      fail('artifact receipt revision file is invalid');
    }
    if (before.nlink === 1n) break;
    if (before.nlink < 1n || attempt === LINK_SETTLE_ATTEMPTS - 1) fail('artifact receipt revision file is invalid');
    await pause(LINK_SETTLE_DELAY_MS);
  }
  const handle = await open(file, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!sameHeldObservation(before, held)) {
      fail('artifact receipt revision changed while opening');
    }
    const bytes = await handle.readFile();
    const after = await lstat(file, { bigint: true });
    if (!samePathObservation(before, after) || !sameHeldObservation(after, held)) {
      fail('artifact receipt revision changed during observation');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readJournal(directory) {
  let root;
  try { root = await realDirectory(directory); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ current: null, digest: null });
    throw error;
  }
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > MAX_REVISIONS) fail('artifact receipt journal exceeds its revision bound');
  const revisions = entries.map((entry) => {
    const match = entry.isFile() ? entry.name.match(REVISION_FILE) : null;
    if (!match) fail(`artifact receipt journal contains an unsupported entry: ${entry.name}`);
    return Number.parseInt(match[1], 10);
  }).sort((left, right) => left - right);
  for (let index = 0; index < revisions.length; index += 1) {
    if (revisions[index] !== index + 1) fail('artifact receipt journal has a missing or duplicate revision');
  }
  let current = null;
  let previousDigest = null;
  for (const revision of revisions) {
    const bytes = await exactFile(path.join(root, revisionName(revision)));
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { fail('artifact receipt revision is not valid JSON'); }
    current = normalizeRecord(parsed, revision, previousDigest);
    if (!bytes.equals(encode(current))) fail('artifact receipt revision is not canonical');
    previousDigest = digestBytes(bytes);
  }
  return Object.freeze({ current, digest: previousDigest });
}

function nextRecord(current, previousDigest, items, identifier) {
  const revision = (current?.revision ?? 0) + 1;
  if (revision > MAX_REVISIONS) fail('artifact receipt journal reached its revision bound');
  const epoch = current?.epoch ?? identifier();
  if (typeof epoch !== 'string' || !UUID.test(epoch)) throw new TypeError('artifact receipt identity dependency returned an invalid value');
  const selected = Object.freeze({
    protocol: EXACT_ARTIFACT_RECEIPT_PROTOCOL,
    revision,
    epoch,
    previousDigest,
    generation: generation(epoch, revision, items),
    items,
  });
  return normalizeRecord(selected, revision, previousDigest);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function publishRevision({ before, items, directory, scratch, identifier }) {
  const next = nextRecord(before.current, before.digest, items, identifier);
  const bytes = encode(next);
  if (bytes.length > MAX_RECORD_BYTES) throw new TypeError('artifact receipt record exceeds its byte bound');
  const root = await realDirectory(directory, { create: true });
  const token = identifier();
  if (typeof token !== 'string' || !UUID.test(token)) throw new TypeError('artifact receipt identity dependency returned an invalid value');
  const temporary = path.join(scratch, `.exact-receipt-${token}.tmp`);
  const target = path.join(root, revisionName(next.revision));
  let handle = null;
  let temporaryCreated = false;
  let published = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, target);
      published = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } finally {
    await handle?.close();
    if (temporaryCreated) await rm(temporary, { force: true });
  }
  if (published) {
    const acceptedBytes = await exactFile(target);
    if (!acceptedBytes.equals(bytes)) fail('artifact receipt accepted revision changed after publication');
    return Object.freeze({ published: true, record: next });
  }
  const observed = await readJournal(directory);
  if (!observed.current) fail('artifact receipt conflicting revision is unavailable');
  return Object.freeze({ published: false, record: observed.current });
}

export function createExactArtifactReceiptJournal({ directory, scratch, identifier = randomUUID } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) {
    throw new TypeError('artifact receipt directory must be an absolute local path');
  }
  if (typeof scratch !== 'string' || !path.isAbsolute(scratch) || scratch.includes('\0')) {
    throw new TypeError('artifact receipt scratch must be an absolute local path');
  }
  if (typeof identifier !== 'function') throw new TypeError('artifact receipt identity dependency is invalid');
  const selectedDirectory = path.resolve(directory);
  const selectedScratch = path.resolve(scratch);
  if (comparable(selectedDirectory) === comparable(selectedScratch)
      || isWithin(selectedDirectory, selectedScratch) || isWithin(selectedScratch, selectedDirectory)) {
    throw new TypeError('artifact receipt journal and scratch must be separate');
  }

  return Object.freeze({
    async read() {
      return (await readJournal(selectedDirectory)).current;
    },
    async accept(rawItems) {
      const items = normalizeItems(rawItems);
      await realDirectory(selectedScratch);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const before = await readJournal(selectedDirectory);
        if (before.current && isDeepStrictEqual(before.current.items, items)) return before.current;
        const result = await publishRevision({
          before,
          items,
          directory: selectedDirectory,
          scratch: selectedScratch,
          identifier,
        });
        if (result.published || isDeepStrictEqual(result.record.items, items)) return result.record;
      }
      fail('artifact receipt journal changed continuously during bounded acceptance');
    },
    async compareAndAccept(rawComparison) {
      const comparison = normalizeComparison(rawComparison);
      await realDirectory(selectedScratch);
      const before = await readJournal(selectedDirectory);
      if ((before.current?.generation ?? null) !== comparison.generation) {
        return Object.freeze({ accepted: false, record: before.current });
      }
      if (before.current && isDeepStrictEqual(before.current.items, comparison.items)) {
        return Object.freeze({ accepted: true, record: before.current });
      }
      const result = await publishRevision({
        before,
        items: comparison.items,
        directory: selectedDirectory,
        scratch: selectedScratch,
        identifier,
      });
      return Object.freeze({ accepted: result.published, record: result.record });
    },
  });
}
