import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  IMMUTABLE_OBJECT_SET_PROTOCOL,
  immutableObjectSetDigest,
} from '../src/runtime/immutable-object-set.js';
import { ImmutableObjectAcquisition } from '../src/runtime/immutable-object-acquisition.js';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
async function tempRoot() { return mkdtemp(path.join(os.tmpdir(), 'db-immutable-acquire-')); }
async function* body(parts, failure = null) {
  for (const part of parts) yield Buffer.from(part);
  if (failure) throw failure;
}

function fixture({ subject = 'fixture-input-v1', name = 'payload.bin', bytes = Buffer.from('abcdefghij'), chunkBytes = 4 } = {}) {
  const chunks = [];
  for (let offset = 0, ordinal = 0; offset < bytes.length; ordinal += 1) {
    const value = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
    chunks.push({ ordinal, name: `${name}.part-${String(ordinal).padStart(6, '0')}`, offset, size: value.length, sha256: sha256(value) });
    offset += value.length;
  }
  return {
    bytes,
    descriptor: {
      protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
      subject,
      objects: [{ name, size: bytes.length, sha256: sha256(bytes), chunks }],
    },
  };
}

function sourceFor(value, hooks = {}) {
  const calls = [];
  return {
    calls,
    async fetch({ subject, object, chunk }) {
      calls.push({ subject, object: object.name, ordinal: chunk.ordinal });
      if (hooks.before) return hooks.before({ subject, object, chunk, calls: calls.length });
      const bytes = value.bytes.subarray(chunk.offset, chunk.offset + chunk.size);
      return { body: body([hooks.bytes?.({ object, chunk, bytes }) ?? bytes], hooks.after?.({ object, chunk, calls: calls.length }) ?? null) };
    },
  };
}

test('acquisition fails over between injected sources without changing exact bytes', async () => {
  const root = await tempRoot();
  try {
    const value = fixture();
    const unavailable = sourceFor(value, { before: () => { throw new Error('source unavailable before body'); } });
    const exact = sourceFor(value);
    const result = await new ImmutableObjectAcquisition({ directory: root, sources: [unavailable, exact] }).ensure({ descriptor: value.descriptor });
    assert.equal(result.state, 'cache-committed');
    assert.deepEqual(await readFile(result.objects[0].location), value.bytes);
    assert.equal(unavailable.calls.length, 1);
    assert.equal(exact.calls.length, value.descriptor.objects[0].chunks.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verified chunks survive interruption and are not fetched again after restart', async () => {
  const root = await tempRoot();
  try {
    const value = fixture();
    const partial = sourceFor(value, { before: ({ chunk, ...input }) => {
      if (chunk.ordinal === 1) throw new Error('interrupted at chunk boundary');
      const bytes = value.bytes.subarray(chunk.offset, chunk.offset + chunk.size);
      return { body: body([bytes]) };
    } });
    const first = new ImmutableObjectAcquisition({ directory: root, sources: [partial] });
    await assert.rejects(() => first.ensure({ descriptor: value.descriptor }), (error) => error?.code === 'IMMUTABLE_OBJECT_UNAVAILABLE');

    const exact = sourceFor(value);
    const result = await new ImmutableObjectAcquisition({ directory: root, sources: [exact] }).ensure({ descriptor: value.descriptor });
    assert.equal(result.reusedChunks, 1);
    assert.deepEqual(exact.calls.map((entry) => entry.ordinal), [1, 2]);
    assert.deepEqual(await readFile(result.objects[0].location), value.bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a source that fails after its last byte cannot publish that attempt', async () => {
  const root = await tempRoot();
  try {
    const value = fixture({ bytes: Buffer.from('abcd'), chunkBytes: 4 });
    const lateFailure = sourceFor(value, { after: () => new Error('connection failed after body') });
    const exact = sourceFor(value);
    const result = await new ImmutableObjectAcquisition({ directory: root, sources: [lateFailure, exact] }).ensure({ descriptor: value.descriptor });
    assert.equal(lateFailure.calls.length, 1);
    assert.equal(exact.calls.length, 1);
    assert.deepEqual(await readFile(result.objects[0].location), value.bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a malformed source iterator fails over before opening destination state', async () => {
  const root = await tempRoot();
  try {
    const value = fixture({ bytes: Buffer.from('abcd'), chunkBytes: 4 });
    let malformedCalls = 0;
    const malformed = {
      async fetch() {
        malformedCalls += 1;
        return { body: { [Symbol.asyncIterator]() { throw new Error('malformed iterator'); } } };
      },
    };
    const exact = sourceFor(value);
    const result = await new ImmutableObjectAcquisition({ directory: root, sources: [malformed, exact] }).ensure({ descriptor: value.descriptor });
    assert.equal(malformedCalls, 1);
    assert.deepEqual(await readFile(result.objects[0].location), value.bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('wrong bytes and wrong lengths are rejected before another source is accepted', async () => {
  const root = await tempRoot();
  try {
    const value = fixture({ bytes: Buffer.from('abcd'), chunkBytes: 4 });
    const wrongBytes = sourceFor(value, { bytes: ({ bytes }) => Buffer.from(bytes.map((entry) => entry ^ 0xff)) });
    const short = sourceFor(value, { bytes: ({ bytes }) => bytes.subarray(0, bytes.length - 1) });
    const exact = sourceFor(value);
    const result = await new ImmutableObjectAcquisition({ directory: root, sources: [wrongBytes, short, exact] }).ensure({ descriptor: value.descriptor });
    assert.equal(wrongBytes.calls.length, 1);
    assert.equal(short.calls.length, 1);
    assert.equal(exact.calls.length, 1);
    assert.deepEqual(await readFile(result.objects[0].location), value.bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an exact committed cache bypasses every source and removes redundant chunks', async () => {
  const root = await tempRoot();
  try {
    const value = fixture();
    const exact = sourceFor(value);
    const first = await new ImmutableObjectAcquisition({ directory: root, sources: [exact] }).ensure({ descriptor: value.descriptor });
    const denied = sourceFor(value, { before: () => { throw new Error('must not fetch'); } });
    const second = await new ImmutableObjectAcquisition({ directory: root, sources: [denied] }).ensure({ descriptor: value.descriptor });
    assert.equal(second.state, 'cached');
    assert.equal(denied.calls.length, 0);
    assert.deepEqual(await readFile(second.objects[0].location), value.bytes);
    assert.deepEqual(await readdir(path.join(root, 'work', immutableObjectSetDigest(value.descriptor))), []);
    assert.equal(first.descriptorSha256, immutableObjectSetDigest(value.descriptor));
    const journal = JSON.parse(await readFile(path.join(root, 'transactions', first.descriptorSha256, 'state.json'), 'utf8'));
    assert.deepEqual(journal.objects.map((object) => object.state), ['cache-committed']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a multi-object set publishes by digest and acquires identical content only once', async () => {
  const root = await tempRoot();
  try {
    const bytes = Buffer.from('shared-object');
    const object = (name) => ({
      name, size: bytes.length, sha256: sha256(bytes),
      chunks: [{ ordinal: 0, name: `${name}.part-000000`, offset: 0, size: bytes.length, sha256: sha256(bytes) }],
    });
    const descriptor = {
      protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
      subject: 'multi-input-v1',
      objects: [object('zeta.bin'), object('alpha.bin')],
    };
    const calls = [];
    const source = { async fetch(input) { calls.push(input.object.name); return { body: body([bytes]) }; } };
    const result = await new ImmutableObjectAcquisition({ directory: root, sources: [source] }).ensure({ descriptor });
    assert.deepEqual(result.objects.map((entry) => entry.name), ['alpha.bin', 'zeta.bin']);
    assert.equal(new Set(result.objects.map((entry) => entry.location)).size, 1);
    assert.deepEqual(calls, ['alpha.bin']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('all sources unavailable returns one typed blocker and preserves prior committed objects', async () => {
  const root = await tempRoot();
  try {
    const retained = fixture({ subject: 'retained-v1', name: 'retained.bin', bytes: Buffer.from('retained') });
    const retainedResult = await new ImmutableObjectAcquisition({ directory: root, sources: [sourceFor(retained)] }).ensure({ descriptor: retained.descriptor });
    const missing = fixture({ subject: 'missing-v1', name: 'missing.bin', bytes: Buffer.from('missing') });
    const deniedFirst = sourceFor(missing, { before: () => { throw new Error('first origin denied'); } });
    const deniedSecond = sourceFor(missing, { before: () => { throw new Error('second origin denied'); } });
    await assert.rejects(
      () => new ImmutableObjectAcquisition({ directory: root, sources: [deniedFirst, deniedSecond] }).ensure({ descriptor: missing.descriptor }),
      (error) => error?.code === 'IMMUTABLE_OBJECT_UNAVAILABLE'
        && error?.subject === 'missing-v1'
        && error?.object === 'missing.bin'
        && error?.chunk === 0
        && error?.attempts === 2,
    );
    assert.deepEqual(await readFile(retainedResult.objects[0].location), retained.bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('durable journal is descriptor-bound and re-observed instead of trusted as completion', async () => {
  const root = await tempRoot();
  try {
    const value = fixture();
    const exact = sourceFor(value);
    const result = await new ImmutableObjectAcquisition({ directory: root, sources: [exact] }).ensure({ descriptor: value.descriptor });
    await rm(result.objects[0].location);
    const replacement = sourceFor(value);
    const recovered = await new ImmutableObjectAcquisition({ directory: root, sources: [replacement] }).ensure({ descriptor: value.descriptor });
    assert.equal(recovered.state, 'cache-committed');
    assert.equal(replacement.calls.length, value.descriptor.objects[0].chunks.length);
    assert.deepEqual(await readFile(recovered.objects[0].location), value.bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('availability observation is exact, read-only, and does not contact sources', async () => {
  const root = await tempRoot();
  try {
    const value = fixture();
    const denied = sourceFor(value, { before: () => { throw new Error('must not fetch'); } });
    const acquisition = new ImmutableObjectAcquisition({ directory: root, sources: [denied] });
    const absent = await acquisition.observe({ descriptor: value.descriptor });
    assert.equal(absent.ready, false);
    assert.equal(absent.objects[0].state, 'absent');
    assert.equal(denied.calls.length, 0);
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(
      () => acquisition.ensure({ descriptor: value.descriptor }),
      (error) => error?.code === 'IMMUTABLE_OBJECT_UNAVAILABLE',
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('availability observation accepts only complete descriptor-bound cache objects', async () => {
  const root = await tempRoot();
  try {
    const value = fixture();
    const acquisition = new ImmutableObjectAcquisition({ directory: root, sources: [sourceFor(value)] });
    const result = await acquisition.ensure({ descriptor: value.descriptor });
    assert.equal((await acquisition.observe({ descriptor: value.descriptor })).ready, true);
    await writeFile(result.objects[0].location, Buffer.alloc(value.bytes.length, 0));
    const corrupt = await acquisition.observe({ descriptor: value.descriptor });
    assert.equal(corrupt.ready, false);
    assert.equal(corrupt.objects[0].state, 'invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('journal substitution and unsafe cache shape fail closed', async () => {
  const root = await tempRoot();
  try {
    const value = fixture();
    const result = await new ImmutableObjectAcquisition({ directory: root, sources: [sourceFor(value)] }).ensure({ descriptor: value.descriptor });
    const journal = path.join(root, 'transactions', result.descriptorSha256, 'state.json');
    const state = JSON.parse(await readFile(journal, 'utf8'));
    await writeFile(journal, `${JSON.stringify({ ...state, subject: 'substituted-v1' })}\n`);
    await assert.rejects(
      () => new ImmutableObjectAcquisition({ directory: root, sources: [sourceFor(value)] }).ensure({ descriptor: value.descriptor }),
      /another subject/u,
    );

    const unsafeRoot = await tempRoot();
    try {
      await mkdir(path.join(unsafeRoot, 'objects'), { recursive: false });
      await rmdir(path.join(unsafeRoot, 'objects'));
      await writeFile(path.join(unsafeRoot, 'objects'), 'not-a-directory');
      await assert.rejects(
        () => new ImmutableObjectAcquisition({ directory: unsafeRoot, sources: [sourceFor(value)] }).ensure({ descriptor: value.descriptor }),
        /real directory/u,
      );
    } finally { await rm(unsafeRoot, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hard-linked acquisition journals fail closed', async () => {
  const root = await tempRoot();
  try {
    const value = fixture();
    const result = await new ImmutableObjectAcquisition({ directory: root, sources: [sourceFor(value)] }).ensure({ descriptor: value.descriptor });
    const journal = path.join(root, 'transactions', result.descriptorSha256, 'state.json');
    await link(journal, path.join(root, 'transactions', result.descriptorSha256, 'state-hardlink.json'));
    await assert.rejects(
      () => new ImmutableObjectAcquisition({ directory: root, sources: [sourceFor(value)] }).ensure({ descriptor: value.descriptor }),
      /unsafe file shape/u,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
