import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { IMMUTABLE_OBJECT_SET_PROTOCOL, immutableObjectSetDigest, normalizeImmutableObjectSet } from './immutable-object-set.js';
import { reobserveImmutableObjectAcquisition } from './immutable-object-acquisition-evidence.js';
import { sameFilesystemIdentity, sameObservedFilesystemIdentity } from './local-filesystem-identity.js';
import { immutableObjectSourceAbort, normalizeImmutableObjectSourceRequest } from './immutable-object-sources/request.js';

const FRAME_BYTES = 4 * 1024 * 1024;
function exact(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return value;
}
function selectedSignal(signal) {
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('pack signal is invalid');
  immutableObjectSourceAbort(signal); return signal ?? null;
}
function uniqueChunks(descriptor) {
  const selected = new Map();
  for (const object of descriptor.objects) for (const chunk of object.chunks) {
    const previous = selected.get(chunk.sha256);
    if (previous && previous.chunk.size !== chunk.size) throw new Error('pack chunk identity conflicts');
    if (!previous) selected.set(chunk.sha256, { object, chunk });
  }
  return [...selected.values()].sort((a, b) => a.chunk.sha256.localeCompare(b.chunk.sha256));
}
function transportObject(object) {
  return { name: object.name, size: object.size, sha256: object.sha256, chunks: [{ ordinal: 0, name: object.name, offset: 0, size: object.size, sha256: object.sha256 }] };
}
function normalizedPacks(raw) {
  const descriptor = normalizeImmutableObjectSet(raw);
  const chunks = descriptor.objects.flatMap(o => o.chunks);
  if (new Set(chunks.map(c => c.sha256)).size !== chunks.length) throw new Error('pack index must cover each chunk exactly once');
  return descriptor;
}
export function immutablePackTransportDescriptor(raw) {
  const descriptor = normalizedPacks(raw);
  return normalizeImmutableObjectSet({ protocol: IMMUTABLE_OBJECT_SET_PROTOCOL, subject: descriptor.subject, objects: descriptor.objects.map(transportObject) });
}

async function writeAll(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (bytesWritten < 1) throw new Error('pack write made no progress');
    offset += bytesWritten;
  }
}
async function writePack(group, descriptor, source, root, ordinal, signal) {
  const name = `pack-${String(ordinal).padStart(5, '0')}`;
  const temporary = path.join(root, `${name}.tmp`);
  const output = await open(temporary, 'wx', 0o600);
  const whole = createHash('sha256'); const chunks = []; let offset = 0;
  try {
    for (const item of group) {
      immutableObjectSourceAbort(signal);
      const response = exact(await source.fetch({ subject: descriptor.subject, ...item, signal }), ['body'], 'pack byte source');
      if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') throw new TypeError('pack source body is invalid');
      const measured = createHash('sha256'); let copied = 0;
      for await (const bytes of response.body) {
        immutableObjectSourceAbort(signal);
        if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > item.chunk.size - copied) throw new Error('pack source byte count mismatch');
        // Bound each filesystem write independently of the source's frame size.
        for (let start = 0; start < bytes.length; start += FRAME_BYTES) {
          immutableObjectSourceAbort(signal);
          const frame = Buffer.from(bytes.subarray(start, Math.min(bytes.length, start + FRAME_BYTES)));
          measured.update(frame); whole.update(frame);
          await writeAll(output, frame, offset + copied + start);
        }
        copied += bytes.length;
      }
      immutableObjectSourceAbort(signal);
      if (copied !== item.chunk.size || measured.digest('hex') !== item.chunk.sha256) throw new Error('pack source chunk failed exact verification');
      chunks.push({ ordinal: chunks.length, name: item.chunk.sha256, offset, size: copied, sha256: item.chunk.sha256 });
      offset += copied;
    }
    await output.sync();
  } finally { await output.close(); }
  const sha256 = whole.digest('hex');
  await rename(temporary, path.join(root, sha256));
  return { name, size: offset, sha256, chunks };
}

export async function buildImmutableObjectPacks(raw = {}) {
  const value = exact(raw, ['descriptor', 'source', 'destination', 'maxPackBytes', 'signal'], 'pack production');
  const signal = selectedSignal(value.signal);
  const descriptor = normalizeImmutableObjectSet(value.descriptor);
  if (!value.source || typeof value.source.fetch !== 'function') throw new TypeError('pack source is invalid');
  if (typeof value.destination !== 'string' || !path.isAbsolute(value.destination) || /[\u0000-\u001f\u007f]/u.test(value.destination)) throw new TypeError('pack destination is invalid');
  if (!Number.isSafeInteger(value.maxPackBytes) || value.maxPackBytes < 1) throw new TypeError('pack byte bound is invalid');
  const groups = []; let current = [], size = 0;
  for (const item of uniqueChunks(descriptor)) {
    if (item.chunk.size > value.maxPackBytes) throw new Error('chunk exceeds pack byte bound');
    if (item.chunk.size > value.maxPackBytes - size) { groups.push(current); current = []; size = 0; }
    current.push(item); size += item.chunk.size;
  }
  if (current.length) groups.push(current);
  // Ask the existing descriptor owner to admit the planned cardinality/coverage
  // before creating files. Provisional whole digests are not published authority.
  const planned = normalizeImmutableObjectSet({ protocol: IMMUTABLE_OBJECT_SET_PROTOCOL, subject: `packs-${immutableObjectSetDigest(descriptor)}`, objects: groups.map((group, i) => {
    let offset = 0;
    const chunks = group.map(({ chunk }, ordinal) => { const result = { ordinal, name: chunk.sha256, offset, size: chunk.size, sha256: chunk.sha256 }; offset += chunk.size; return result; });
    return { name: `pack-${String(i).padStart(5, '0')}`, size: offset, sha256: createHash('sha256').update(String(i)).digest('hex'), chunks };
  }) });
  const root = path.resolve(value.destination); const parent = path.dirname(root);
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || !await sameFilesystemIdentity(parent, await realpath(parent))) throw new Error('pack parent must be a direct directory');
  immutableObjectSourceAbort(signal);
  await mkdir(root, { recursive: false, mode: 0o700 });
  const owned = await lstat(root, { bigint: true });
  try {
    const objects = [];
    for (let i = 0; i < groups.length; i++) objects.push(await writePack(groups[i], descriptor, value.source, root, i, signal));
    immutableObjectSourceAbort(signal);
    return Object.freeze({ root, descriptor: normalizedPacks({ protocol: IMMUTABLE_OBJECT_SET_PROTOCOL, subject: planned.subject, objects }) });
  } catch (error) {
    try {
      const current = await lstat(root, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !sameObservedFilesystemIdentity(owned, current)) throw new Error('pack output ownership changed');
      await rm(root, { recursive: true, force: false });
    }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'pack production failed; owned output cleanup incomplete'); }
    throw error;
  }
}

function sameFile(a, b) {
  return sameObservedFilesystemIdentity(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function* readSlice(location, pack, chunk, signal) {
  immutableObjectSourceAbort(signal);
  if (!await sameFilesystemIdentity(location, await realpath(location))) throw new Error('pack location is indirect');
  const before = await lstat(location, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(pack.size)) throw new Error('pack file shape changed');
  const file = await open(location, 'r');
  try {
    const held = await file.stat({ bigint: true });
    if (!sameFile(before, held)) throw new Error('pack file changed while opening');
    const buffer = Buffer.allocUnsafe(Math.min(FRAME_BYTES, chunk.size)); const measured = createHash('sha256'); let copied = 0;
    while (copied < chunk.size) {
      immutableObjectSourceAbort(signal);
      const count = Math.min(buffer.length, chunk.size - copied);
      const { bytesRead } = await file.read(buffer, 0, count, chunk.offset + copied);
      if (bytesRead !== count) throw new Error('pack slice truncated');
      measured.update(buffer.subarray(0, bytesRead)); copied += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    immutableObjectSourceAbort(signal);
    const after = await lstat(location, { bigint: true });
    if (!sameFile(held, after) || measured.digest('hex') !== chunk.sha256) throw new Error('pack slice failed exact verification');
  } finally { await file.close(); }
}

export class PackedImmutableObjectSource {
  #descriptor; #acquisition; #entries = new Map(); #observed = new Map();
  constructor(raw = {}) {
    const value = exact(raw, ['descriptor', 'acquisition'], 'packed source');
    this.#descriptor = normalizedPacks(value.descriptor);
    if (!value.acquisition || typeof value.acquisition.ensure !== 'function') throw new TypeError('packed source acquisition is invalid');
    this.#acquisition = value.acquisition;
    for (const object of this.#descriptor.objects) for (const chunk of object.chunks) this.#entries.set(chunk.sha256, { object, chunk });
  }
  async fetch(raw) {
    const request = normalizeImmutableObjectSourceRequest(raw); immutableObjectSourceAbort(request.signal);
    const entry = this.#entries.get(request.chunk.sha256);
    if (!entry || entry.chunk.size !== request.chunk.size) throw new Error('requested chunk is absent from pack index');
    let observation = this.#observed.get(entry.object.sha256);
    if (!observation) {
      const descriptor = normalizeImmutableObjectSet({ protocol: IMMUTABLE_OBJECT_SET_PROTOCOL, subject: `pack-${entry.object.sha256}`, objects: [transportObject(entry.object)] });
      // Only completed independently reobserved evidence is reusable. Failed or
      // cancelled acquisition creates no memoized success and may be retried.
      observation = await reobserveImmutableObjectAcquisition({ descriptor, evidence: await this.#acquisition.ensure({ descriptor, signal: request.signal }), signal: request.signal });
      this.#observed.set(entry.object.sha256, observation);
    }
    return Object.freeze({ body: readSlice(observation.objects[0].location, entry.object, entry.chunk, request.signal) });
  }
}
