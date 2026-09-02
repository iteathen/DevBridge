import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImmutableObjectAcquisition } from '../src/runtime/immutable-object-acquisition.js';
import { IMMUTABLE_OBJECT_SET_PROTOCOL } from '../src/runtime/immutable-object-set.js';
import { FilesystemImmutableObjectSource } from '../src/runtime/immutable-object-sources/filesystem.js';
import { HttpsImmutableObjectSource } from '../src/runtime/immutable-object-sources/https.js';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
async function tempRoot() { return mkdtemp(path.join(os.tmpdir(), 'db-immutable-sources-')); }
async function collect(body) { const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
function inertTimeout(observed) {
  return (milliseconds) => {
    observed.push(milliseconds);
    return new AbortController().signal;
  };
}
function request(bytes = Buffer.from('exact bytes')) {
  const chunk = Object.freeze({ ordinal: 0, name: 'payload.part-000000', offset: 0, size: bytes.length, sha256: sha256(bytes) });
  const object = Object.freeze({ name: 'payload.bin', size: bytes.length, sha256: sha256(bytes), chunks: Object.freeze([chunk]) });
  return Object.freeze({ subject: 'release-input-v1', object, chunk, signal: null });
}
function response(status, bytes, headers = {}) {
  return new Response(bytes, { status, headers });
}
function descriptor(bytes, chunkBytes = 4) {
  const chunks = [];
  for (let offset = 0, ordinal = 0; offset < bytes.length; ordinal += 1) {
    const value = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
    chunks.push({ ordinal, name: `payload.part-${String(ordinal).padStart(6, '0')}`, offset, size: value.length, sha256: sha256(value) });
    offset += value.length;
  }
  return {
    protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
    subject: 'release-input-v1',
    objects: [{ name: 'payload.bin', size: bytes.length, sha256: sha256(bytes), chunks }],
  };
}

test('HTTPS immutable source requests only the exact digest leaf with explicit duration and no redirects', async () => {
  const bytes = Buffer.from('exact bytes');
  const observedDurations = [];
  const calls = [];
  const source = new HttpsImmutableObjectSource({
    baseUrl: 'https://primary.example.invalid/release/chunks/',
    maxDurationMs: 12_345,
    timeoutSignal: inertTimeout(observedDurations),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(200, bytes, { 'content-length': String(bytes.length) });
    },
  });
  const supplied = await source.fetch(request(bytes));
  assert.deepEqual(await collect(supplied.body), bytes);
  assert.deepEqual(observedDurations, [12_345]);
  assert.equal(calls[0].url, `https://primary.example.invalid/release/chunks/${sha256(bytes)}`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(calls[0].options.headers, { accept: 'application/octet-stream', 'accept-encoding': 'identity' });
  assert.equal(calls[0].url.includes('release-input-v1'), false);
  assert.equal(calls[0].url.includes('payload'), false);
});

test('HTTPS immutable source rejects ambiguous URL and duration policy before transport', () => {
  const common = { maxDurationMs: 1_000, fetchImpl: async () => { throw new Error('must not fetch'); } };
  assert.throws(() => new HttpsImmutableObjectSource({ baseUrl: 'http://example.invalid/chunks/', ...common }), /HTTPS/u);
  assert.throws(() => new HttpsImmutableObjectSource({ baseUrl: 'https://example.invalid/chunks?moving=1', ...common }), /base URL/u);
  assert.throws(() => new HttpsImmutableObjectSource({ baseUrl: 'https://example.invalid/chunks', ...common }), /trailing slash/u);
  assert.throws(() => new HttpsImmutableObjectSource({ baseUrl: 'https://example.invalid/chunks/' }), /duration/u);
});

test('HTTPS immutable source rejects widened chunk requests before transport', async () => {
  const bytes = Buffer.from('exact bytes');
  let calls = 0;
  const source = new HttpsImmutableObjectSource({
    baseUrl: 'https://primary.example.invalid/chunks/', maxDurationMs: 1_000, timeoutSignal: inertTimeout([]),
    fetchImpl: async () => { calls += 1; return response(200, bytes, { 'content-length': String(bytes.length) }); },
  });
  const value = request(bytes);
  await assert.rejects(() => source.fetch({ ...value, chunk: { ...value.chunk, url: 'https://attacker.invalid/value' } }), /url is not allowed/u);
  assert.equal(calls, 0);
});

test('HTTPS immutable source rejects redirect, range, encoding, and declared-length drift', async () => {
  const bytes = Buffer.from('exact bytes');
  const cases = [
    [response(302, null, { location: 'https://other.example.invalid/value' }), /HTTP 302/u],
    [response(200, bytes, { 'content-length': String(bytes.length), 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` }), /range/u],
    [response(200, bytes, { 'content-length': String(bytes.length), 'content-encoding': 'gzip' }), /encoding/u],
    [response(200, bytes, { 'content-length': String(bytes.length - 1) }), /byte count/u],
    [response(200, bytes), /content length/u],
  ];
  for (const [supplied, expected] of cases) {
    const source = new HttpsImmutableObjectSource({
      baseUrl: 'https://primary.example.invalid/chunks/', maxDurationMs: 1_000,
      timeoutSignal: inertTimeout([]), fetchImpl: async () => supplied,
    });
    await assert.rejects(() => source.fetch(request(bytes)), expected);
  }
});

test('HTTPS immutable source applies its duration signal to body iteration', async () => {
  const bytes = Buffer.from('exact bytes');
  const controller = new AbortController();
  const source = new HttpsImmutableObjectSource({
    baseUrl: 'https://primary.example.invalid/chunks/', maxDurationMs: 1_000,
    timeoutSignal: () => controller.signal,
    fetchImpl: async () => response(200, bytes, { 'content-length': String(bytes.length) }),
  });
  const supplied = await source.fetch(request(bytes));
  controller.abort(new Error('duration elapsed'));
  await assert.rejects(() => collect(supplied.body), (error) => error?.name === 'AbortError');
});

test('HTTPS immutable source bounds response acquisition even when fetch does not honor its signal', async () => {
  const bytes = Buffer.from('exact bytes');
  const controller = new AbortController();
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const source = new HttpsImmutableObjectSource({
    baseUrl: 'https://primary.example.invalid/chunks/', maxDurationMs: 1_000,
    timeoutSignal: () => controller.signal,
    fetchImpl: async () => { started(); return new Promise(() => {}); },
  });
  const pending = source.fetch(request(bytes));
  await began;
  controller.abort(new Error('duration elapsed'));
  await assert.rejects(() => pending, (error) => error?.name === 'AbortError');
});

test('two independently configured HTTPS sources fail over once for a multi-chunk object', async () => {
  const root = await tempRoot();
  try {
    const bytes = Buffer.from('abcdefghij');
    const authority = descriptor(bytes);
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const primary = new HttpsImmutableObjectSource({
      baseUrl: 'https://primary.example.invalid/chunks/', maxDurationMs: 1_000, timeoutSignal: inertTimeout([]),
      fetchImpl: async () => { primaryCalls += 1; return response(503, null, { 'content-length': '0' }); },
    });
    const secondary = new HttpsImmutableObjectSource({
      baseUrl: 'https://secondary.example.invalid/chunks/', maxDurationMs: 1_000, timeoutSignal: inertTimeout([]),
      fetchImpl: async (url) => {
        secondaryCalls += 1;
        const chunk = authority.objects[0].chunks.find((entry) => String(url).endsWith(entry.sha256));
        const value = bytes.subarray(chunk.offset, chunk.offset + chunk.size);
        return response(200, value, { 'content-length': String(value.length) });
      },
    });
    const result = await new ImmutableObjectAcquisition({ directory: path.join(root, 'cache'), sources: [primary, secondary] }).ensure({ descriptor: authority });
    assert.deepEqual(await readFile(result.objects[0].location), bytes);
    assert.equal(primaryCalls, 1);
    assert.equal(secondaryCalls, authority.objects[0].chunks.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('one HTTPS source duration expiry fails over without cancelling the acquisition', async () => {
  const root = await tempRoot();
  try {
    const bytes = Buffer.from('exact bytes');
    const authority = descriptor(bytes, bytes.length);
    const expired = new AbortController();
    expired.abort(new Error('source duration elapsed'));
    let expiredFetches = 0;
    const primary = new HttpsImmutableObjectSource({
      baseUrl: 'https://primary.example.invalid/chunks/', maxDurationMs: 1_000, timeoutSignal: () => expired.signal,
      fetchImpl: async () => { expiredFetches += 1; throw new Error('must not fetch after expiry'); },
    });
    const secondary = new HttpsImmutableObjectSource({
      baseUrl: 'https://secondary.example.invalid/chunks/', maxDurationMs: 1_000, timeoutSignal: inertTimeout([]),
      fetchImpl: async () => response(200, bytes, { 'content-length': String(bytes.length) }),
    });
    const result = await new ImmutableObjectAcquisition({ directory: path.join(root, 'cache'), sources: [primary, secondary] }).ensure({ descriptor: authority });
    assert.deepEqual(await readFile(result.objects[0].location), bytes);
    assert.equal(expiredFetches, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('filesystem immutable source reads only an exact digest-named regular file', async () => {
  const root = await tempRoot();
  try {
    const bytes = Buffer.from('offline bytes');
    await writeFile(path.join(root, sha256(bytes)), bytes);
    await writeFile(path.join(root, 'payload.part-000000'), Buffer.from('substituted'));
    const supplied = await new FilesystemImmutableObjectSource({ directory: root }).fetch(request(bytes));
    assert.deepEqual(await collect(supplied.body), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('filesystem immutable source rejects missing, mismatched, and hard-linked objects without mutation', async () => {
  const root = await tempRoot();
  try {
    const bytes = Buffer.from('offline bytes');
    const digest = sha256(bytes);
    const source = new FilesystemImmutableObjectSource({ directory: root });
    await assert.rejects(() => source.fetch(request(bytes)), /ENOENT/u);
    await writeFile(path.join(root, digest), bytes.subarray(0, bytes.length - 1));
    await assert.rejects(() => source.fetch(request(bytes)), /byte count/u);
    await writeFile(path.join(root, digest), bytes);
    await link(path.join(root, digest), path.join(root, 'retained-hardlink'));
    await assert.rejects(() => source.fetch(request(bytes)), /unsafe file shape/u);
    assert.deepEqual(await readFile(path.join(root, digest)), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('offline filesystem source completes a blank cache when HTTPS is unavailable', async () => {
  const root = await tempRoot();
  try {
    const bytes = Buffer.from('offline complete object');
    const authority = descriptor(bytes, 5);
    const offline = path.join(root, 'offline');
    await mkdir(offline);
    for (const chunk of authority.objects[0].chunks) {
      await writeFile(path.join(offline, chunk.sha256), bytes.subarray(chunk.offset, chunk.offset + chunk.size));
    }
    let remoteCalls = 0;
    const remote = new HttpsImmutableObjectSource({
      baseUrl: 'https://denied.example.invalid/chunks/', maxDurationMs: 1_000, timeoutSignal: inertTimeout([]),
      fetchImpl: async () => { remoteCalls += 1; throw new Error('network denied'); },
    });
    const result = await new ImmutableObjectAcquisition({
      directory: path.join(root, 'cache'),
      sources: [remote, new FilesystemImmutableObjectSource({ directory: offline })],
    }).ensure({ descriptor: authority });
    assert.deepEqual(await readFile(result.objects[0].location), bytes);
    assert.equal(remoteCalls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('same-size corrupt offline bytes fail closed before cache publication', async () => {
  const root = await tempRoot();
  try {
    const bytes = Buffer.from('offline object');
    const authority = descriptor(bytes, bytes.length);
    const offline = path.join(root, 'offline');
    await mkdir(offline);
    const chunk = authority.objects[0].chunks[0];
    await writeFile(path.join(offline, chunk.sha256), Buffer.alloc(chunk.size, 0));
    const cache = path.join(root, 'cache');
    await assert.rejects(
      () => new ImmutableObjectAcquisition({ directory: cache, sources: [new FilesystemImmutableObjectSource({ directory: offline })] }).ensure({ descriptor: authority }),
      (error) => error?.code === 'IMMUTABLE_OBJECT_UNAVAILABLE' && error?.attempts === 1,
    );
    const observed = await new ImmutableObjectAcquisition({ directory: cache, sources: [new FilesystemImmutableObjectSource({ directory: offline })] }).observe({ descriptor: authority });
    assert.equal(observed.ready, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
