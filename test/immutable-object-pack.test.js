import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildImmutableObjectPacks, immutablePackTransportDescriptor, PackedImmutableObjectSource } from '../src/runtime/immutable-object-pack.js';
import { IMMUTABLE_OBJECT_SET_PROTOCOL } from '../src/runtime/immutable-object-set.js';
import { ImmutableObjectAcquisition } from '../src/runtime/immutable-object-acquisition.js';
import { FilesystemImmutableObjectSource } from '../src/runtime/immutable-object-sources/filesystem.js';
import { ImmutableReleasePublicationGate } from '../src/release/immutable-release-publication-gate.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
function fixture(values = ['aaa', 'bbbb', 'cc', 'aaa']) {
  const bytes = values.map(v => Buffer.from(v));
  const descriptor = { protocol: IMMUTABLE_OBJECT_SET_PROTOCOL, subject: 'pack-test', objects: bytes.map((b, i) => ({ name: `item-${i}`, size: b.length, sha256: hash(b), chunks: [{ ordinal: 0, name: `chunk-${i}`, offset: 0, size: b.length, sha256: hash(b) }] })) };
  const byDigest = new Map(bytes.map(b => [hash(b), b]));
  const source = { async fetch({ chunk }) { return { body: (async function* () { yield byDigest.get(chunk.sha256); })() }; } };
  return { descriptor, source };
}
async function temporary(work) { const root = await mkdtemp(path.join(os.tmpdir(), 'db-immutable-pack-')); try { await work(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function consume(response) { const buffers = []; for await (const b of response.body) buffers.push(Buffer.from(b)); return Buffer.concat(buffers); }

test('packs preserve original chunks and compose existing acquisition/source owners', () => temporary(async root => {
  const f = fixture(); const original = JSON.stringify(f.descriptor);
  const result = await buildImmutableObjectPacks({ ...f, destination: path.join(root, 'packs'), maxPackBytes: 6 });
  assert.equal(JSON.stringify(f.descriptor), original);
  assert.equal(result.descriptor.objects.length, 2);
  assert.equal(result.descriptor.objects.flatMap(o => o.chunks).length, 3);
  const transport = immutablePackTransportDescriptor(result.descriptor);
  assert.ok(transport.objects.every(o => o.chunks.length === 1 && o.chunks[0].sha256 === o.sha256));
  let reads = 0;
  const disk = new FilesystemImmutableObjectSource({ directory: result.root });
  const acquisition = new ImmutableObjectAcquisition({ directory: path.join(root, 'cache'), sources: [{ fetch(r) { reads++; return disk.fetch(r); } }] });
  const reader = new PackedImmutableObjectSource({ descriptor: result.descriptor, acquisition });
  for (const object of f.descriptor.objects) {
    const actual = await consume(await reader.fetch({ subject: f.descriptor.subject, object, chunk: object.chunks[0] }));
    assert.equal(hash(actual), object.sha256);
  }
  assert.equal(reads, 2);
}));

test('pack admission rejects unsupported and oversized input before creating output', () => temporary(async root => {
  const f = fixture(); const destination = path.join(root, 'packs');
  await assert.rejects(buildImmutableObjectPacks({ ...f, destination, maxPackBytes: 3 }), /bound/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  await assert.rejects(buildImmutableObjectPacks({ ...f, destination, maxPackBytes: 10, surprise: true }), /unsupported/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  await assert.rejects(buildImmutableObjectPacks({ ...f, destination, maxPackBytes: Number.MAX_SAFE_INTEGER + 1 }), /bound/);
}));

test('corrupt, short, extra and late-failed source bytes roll back only owned output and allow retry', () => temporary(async root => {
  const f = fixture(); const destination = path.join(root, 'packs');
  for (const mode of ['wrong', 'short', 'extra', 'late']) {
    let calls = 0;
    const source = { async fetch(request) { const original = await f.source.fetch(request); return { body: (async function* () {
      const b = await consume(original); calls++;
      if (mode === 'late' && calls === 2) throw new Error('late test failure');
      yield mode === 'wrong' ? Buffer.alloc(b.length) : mode === 'short' ? b.subarray(1) : b;
      if (mode === 'extra') yield Buffer.from('x');
    })() }; } };
    await assert.rejects(buildImmutableObjectPacks({ descriptor: f.descriptor, source, destination, maxPackBytes: 6 }));
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  }
  const result = await buildImmutableObjectPacks({ ...f, destination, maxPackBytes: 6 });
  await assert.rejects(buildImmutableObjectPacks({ ...f, destination, maxPackBytes: 6 }), /exists/);
  assert.ok((await stat(result.root)).isDirectory());
}));

test('cancellation closes producer iterator and preserves unrelated files', () => temporary(async root => {
  const f = fixture(); const control = new AbortController(); let closed = false;
  const source = { fetch: async r => ({ body: (async function* () { try { yield await consume(await f.source.fetch(r)); control.abort(); } finally { closed = true; } })() }) };
  await writeFile(path.join(root, 'keep'), 'user file');
  await assert.rejects(buildImmutableObjectPacks({ descriptor: f.descriptor, source, destination: path.join(root, 'packs'), maxPackBytes: 6, signal: control.signal }));
  assert.equal(closed, true); assert.equal(await readFile(path.join(root, 'keep'), 'utf8'), 'user file');
  await assert.rejects(stat(path.join(root, 'packs')), { code: 'ENOENT' });
}));

test('packed source rejects inconsistent mapping, forged receipts, then retries real acquisition', () => temporary(async root => {
  const f = fixture(); const result = await buildImmutableObjectPacks({ ...f, destination: path.join(root, 'packs'), maxPackBytes: 6 });
  const malformed = structuredClone(result.descriptor); malformed.objects[0].chunks[0].offset = 1;
  assert.throws(() => immutablePackTransportDescriptor(malformed), /contiguous/);
  const real = new ImmutableObjectAcquisition({ directory: path.join(root, 'cache'), sources: [new FilesystemImmutableObjectSource({ directory: result.root })] });
  let forged = true;
  const reader = new PackedImmutableObjectSource({ descriptor: result.descriptor, acquisition: { ensure: r => forged ? Promise.resolve({ state: 'cached', objects: [] }) : real.ensure(r) } });
  const object = f.descriptor.objects[0]; const request = { subject: f.descriptor.subject, object, chunk: object.chunks[0] };
  await assert.rejects(reader.fetch(request)); forged = false;
  assert.equal(hash(await consume(await reader.fetch(request))), object.sha256);
}));

test('real-consumer cardinality needs a few packs, not one transport file per chunk', () => temporary(async root => {
  const f = fixture(Array.from({ length: 2579 }, (_, i) => String(i).padStart(5, '0')));
  const result = await buildImmutableObjectPacks({ ...f, destination: path.join(root, 'packs'), maxPackBytes: 5000 });
  assert.equal(result.descriptor.objects.length, 3);
  assert.equal(result.descriptor.objects.flatMap(o => o.chunks).length, 2579);
}));

test('cached pack slices are reverified and handles close after mutation or early return', () => temporary(async root => {
  const f = fixture(['aaaa', 'bbbb']);
  const result = await buildImmutableObjectPacks({ ...f, destination: path.join(root, 'packs'), maxPackBytes: 10 });
  const acquisition = new ImmutableObjectAcquisition({ directory: path.join(root, 'cache'), sources: [new FilesystemImmutableObjectSource({ directory: result.root })] });
  const reader = new PackedImmutableObjectSource({ descriptor: result.descriptor, acquisition });
  const object = f.descriptor.objects[0], request = { subject: f.descriptor.subject, object, chunk: object.chunks[0] };
  const first = await reader.fetch(request); const iterator = first.body[Symbol.asyncIterator](); await iterator.next(); await iterator.return();
  const cache = path.join(root, 'cache', 'objects', result.descriptor.objects[0].sha256);
  await writeFile(cache, Buffer.alloc(8));
  await assert.rejects(consume(await reader.fetch(request)), /verification/);
  await rm(cache); // Also proves both ordinary and failed reader handles closed on Windows.
}));

test('whole-pack publication composes unchanged authority-last gate and exact chunk consumption', () => temporary(async root => {
  const f = fixture(); const result = await buildImmutableObjectPacks({ ...f, destination: path.join(root, 'packs'), maxPackBytes: 6 });
  const descriptor = immutablePackTransportDescriptor(result.descriptor);
  const remote = new Map(), authority = new Map(), events = [];
  const destination = { identity: 'test-pack-origin',
    objects: { async ensure(o) { remote.set(o.sha256, await readFile(o.location)); events.push('object'); } },
    source: { async fetch(r) { events.push('read-object'); return { body: (async function* () { yield remote.get(r.chunk.sha256); })() }; } },
    authority: { async ensure(r) { authority.set(r.name, Buffer.from(r.bytes)); events.push(r.name); }, async read(r) { return authority.get(r.name); } },
  };
  await new ImmutableReleasePublicationGate({ destinations: [destination] }).publish({ descriptors: [descriptor], objects: descriptor.objects.map(o => ({ sha256: o.sha256, size: o.size, location: path.join(result.root, o.sha256) })), authorityPrerequisites: [{ name: 'pack-index', bytes: Buffer.from(JSON.stringify(result.descriptor)) }], authorityCommit: { name: 'original-manifest', bytes: Buffer.from(JSON.stringify(f.descriptor)) } });
  assert.deepEqual(events, ['object', 'object', 'read-object', 'read-object', 'pack-index', 'original-manifest']);
  const reader = new PackedImmutableObjectSource({ descriptor: result.descriptor, acquisition: new ImmutableObjectAcquisition({ directory: path.join(root, 'empty-cache'), sources: [destination.source] }) });
  for (const object of f.descriptor.objects) assert.equal(hash(await consume(await reader.fetch({ subject: f.descriptor.subject, object, chunk: object.chunks[0] }))), object.sha256);
}));
