import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import {
  UBUNTU_SNAPSHOT_ARCHIVE_HTTPS_SOURCE_PROTOCOL,
  UbuntuSnapshotArchiveHttpsSource,
} from '../src/release/ubuntu-snapshot-archive-https-source.mjs';

const SNAPSHOT = '20260821T230000Z';
const PATH = 'dists/resolute/InRelease';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function inertTimeout(observed = []) {
  return (milliseconds) => { observed.push(milliseconds); return new AbortController().signal; };
}
function response(status, bytes, headers = {}) { return new Response(bytes, { status, headers }); }

test('snapshot HTTPS source requests one bounded path under its exact snapshot without redirects', async () => {
  const bytes = Buffer.from('exact snapshot bytes');
  const durations = [];
  const calls = [];
  const source = new UbuntuSnapshotArchiveHttpsSource({
    baseUrl: 'https://snapshot.example.invalid/ubuntu/',
    snapshot: SNAPSHOT,
    maxDurationMs: 12_345,
    timeoutSignal: inertTimeout(durations),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(200, bytes, { 'content-length': String(bytes.length) });
    },
  });
  assert.equal(UBUNTU_SNAPSHOT_ARCHIVE_HTTPS_SOURCE_PROTOCOL, 'devbridge/ubuntu-snapshot-archive-https-source-v1');
  assert.deepEqual(await source.read({ path: PATH, maximum: 1024 }), bytes);
  assert.deepEqual(durations, [12_345]);
  assert.equal(calls[0].url, `https://snapshot.example.invalid/ubuntu/${SNAPSHOT}/${PATH}`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(calls[0].options.headers, { accept: 'application/octet-stream', 'accept-encoding': 'identity' });
});

test('snapshot HTTPS source rejects ambiguous origin, snapshot, request, and identity policy before transport', async () => {
  const common = { snapshot: SNAPSHOT, maxDurationMs: 1_000, fetchImpl: async () => { throw new Error('must not fetch'); } };
  assert.throws(() => new UbuntuSnapshotArchiveHttpsSource({ baseUrl: 'http://example.invalid/ubuntu/', ...common }), /approved HTTPS/u);
  assert.throws(() => new UbuntuSnapshotArchiveHttpsSource({ baseUrl: 'https://example.invalid/ubuntu/?moving=1', ...common }), /approved HTTPS/u);
  assert.throws(() => new UbuntuSnapshotArchiveHttpsSource({ baseUrl: 'https://example.invalid/ubuntu', ...common }), /approved HTTPS/u);
  assert.throws(() => new UbuntuSnapshotArchiveHttpsSource({ baseUrl: 'https://example.invalid/ubuntu/', ...common, snapshot: 'latest' }), /snapshot is invalid/u);
  assert.throws(() => new UbuntuSnapshotArchiveHttpsSource({ baseUrl: 'https://example.invalid/ubuntu/', ...common, maxDurationMs: 999 }), /duration/u);
  const source = new UbuntuSnapshotArchiveHttpsSource({ baseUrl: 'https://example.invalid/ubuntu/', ...common, timeoutSignal: inertTimeout() });
  await assert.rejects(() => source.read({ path: '../escape', maximum: 10 }), /path is invalid/u);
  await assert.rejects(() => source.read({ path: PATH, maximum: 10, size: 4 }), /identity is incomplete/u);
  await assert.rejects(() => source.read({ path: PATH, maximum: 10, sha256: 'a'.repeat(64) }), /identity is incomplete/u);
  await assert.rejects(() => source.read({ path: PATH, maximum: 10, size: 11, sha256: 'a'.repeat(64) }), /identity is invalid/u);
});

test('snapshot HTTPS source rejects response transformation, bounds drift, and exact-byte substitution', async () => {
  const bytes = Buffer.from('exact bytes');
  const cases = [
    [response(503, null, { 'content-length': '1' }), {}, /HTTP 503/u],
    [response(200, bytes), {}, /content length/u],
    [response(200, bytes, { 'content-length': String(bytes.length), 'content-range': 'bytes 0-10/11' }), {}, /range/u],
    [response(200, bytes, { 'content-length': String(bytes.length), 'content-encoding': 'gzip' }), {}, /encoding/u],
    [response(200, bytes, { 'content-length': String(bytes.length) }), { maximum: bytes.length - 1 }, /exceeds its bound/u],
    [response(200, bytes, { 'content-length': String(bytes.length) }), { size: bytes.length - 1, sha256: sha256(bytes) }, /identity is invalid|does not match authority/u],
    [response(200, Buffer.alloc(bytes.length, 0), { 'content-length': String(bytes.length) }), { size: bytes.length, sha256: sha256(bytes) }, /do not match exact authority/u],
  ];
  for (const [supplied, changes, expected] of cases) {
    const source = new UbuntuSnapshotArchiveHttpsSource({
      baseUrl: 'https://snapshot.example.invalid/ubuntu/', snapshot: SNAPSHOT, maxDurationMs: 1_000,
      timeoutSignal: inertTimeout(), fetchImpl: async () => supplied,
    });
    await assert.rejects(() => source.read({ path: PATH, maximum: bytes.length, ...changes }), expected);
  }
});

test('snapshot HTTPS source bounds body growth and fetch implementations that ignore cancellation', async () => {
  const growing = new UbuntuSnapshotArchiveHttpsSource({
    baseUrl: 'https://snapshot.example.invalid/ubuntu/', snapshot: SNAPSHOT, maxDurationMs: 1_000,
    timeoutSignal: inertTimeout(),
    fetchImpl: async () => ({
      status: 200,
      redirected: false,
      headers: new Headers({ 'content-length': '3' }),
      body: { async *[Symbol.asyncIterator]() { yield Buffer.from('ab'); yield Buffer.from('cd'); } },
    }),
  });
  await assert.rejects(() => growing.read({ path: PATH, maximum: 3 }), /exceeds its byte bound/u);

  const controller = new AbortController();
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const stalled = new UbuntuSnapshotArchiveHttpsSource({
    baseUrl: 'https://snapshot.example.invalid/ubuntu/', snapshot: SNAPSHOT, maxDurationMs: 1_000,
    timeoutSignal: () => controller.signal,
    fetchImpl: async () => { began(); return new Promise(() => {}); },
  });
  const pending = stalled.read({ path: PATH, maximum: 10 });
  await started;
  controller.abort(new Error('duration elapsed'));
  await assert.rejects(() => pending, (error) => error?.name === 'AbortError');
});

test('snapshot HTTPS source remains a release adapter without setup or provider behavior', async () => {
  const source = await readFile(new URL('../src/release/ubuntu-snapshot-archive-https-source.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['setup --construct', 'Hyper-V', 'libvirt', 'Start-VM', 'snapshot.ubuntu.com']) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'u'));
  }
});

test('snapshot HTTPS source preserves gzip archive bytes only under exact authority', async () => {
  const bytes = gzipSync(Buffer.from('signed source patch'));
  const exact = { path: 'pool/main/l/linux/source.diff.gz', maximum: bytes.length, size: bytes.length, sha256: sha256(bytes) };
  for (const encoding of ['gzip', ' GZip ']) {
    const source = new UbuntuSnapshotArchiveHttpsSource({
      baseUrl: 'https://snapshot.example.invalid/ubuntu/', snapshot: SNAPSHOT, maxDurationMs: 1_000,
      timeoutSignal: inertTimeout(), fetchImpl: async () => response(200, bytes, {
        'content-length': String(bytes.length), 'content-encoding': encoding,
      }),
    });
    assert.deepEqual(await source.read(exact), bytes);
  }
  for (const [body, encoding, changes, expected] of [
    [bytes, 'gzip', { size: undefined, sha256: undefined }, /encoding/u],
    [bytes, 'br', {}, /encoding/u],
    [bytes, 'gzip, gzip', {}, /encoding/u],
    [bytes, 'gzip, identity', {}, /encoding/u],
    [gunzipSync(bytes), 'gzip', {}, /byte count|exact authority/u],
    [Buffer.alloc(bytes.length), 'gzip', {}, /exact authority/u],
    [bytes, 'gzip', { sha256: 'a'.repeat(64) }, /exact authority/u],
  ]) {
    const source = new UbuntuSnapshotArchiveHttpsSource({
      baseUrl: 'https://snapshot.example.invalid/ubuntu/', snapshot: SNAPSHOT, maxDurationMs: 1_000,
      timeoutSignal: inertTimeout(), fetchImpl: async () => response(200, body, {
        'content-length': String(bytes.length), 'content-encoding': encoding,
      }),
    });
    await assert.rejects(() => source.read({ ...exact, ...changes }), expected);
  }
});

test('snapshot default transport uses raw HTTPS and closes rejected responses before retry', async (t) => {
  const bytes = gzipSync(Buffer.from('signed raw source'));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('decompressing fetch must not be used'); });
  t.mock.method(https, 'get', (url, options, callback) => {
    const body = Readable.from([bytes]);
    body.statusCode = calls.length === 0 ? 302 : 200;
    body.headers = { 'content-length': String(bytes.length), 'content-encoding': 'gzip' };
    calls.push({ url: String(url), options, body });
    options.signal.addEventListener('abort', () => body.destroy(), { once: true });
    queueMicrotask(() => callback(body));
    return new EventEmitter();
  });
  const source = new UbuntuSnapshotArchiveHttpsSource({
    baseUrl: 'https://snapshot.example.invalid/ubuntu/', snapshot: SNAPSHOT, maxDurationMs: 1_000,
    timeoutSignal: inertTimeout(),
  });
  const request = { path: PATH, maximum: bytes.length, size: bytes.length, sha256: sha256(bytes) };
  await assert.rejects(() => source.read(request), /HTTP 302/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(calls[0].body.destroyed, true);
  assert.deepEqual(await source.read(request), bytes);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.signal.aborted, true);
  assert.equal(calls[1].url, `https://snapshot.example.invalid/ubuntu/${SNAPSHOT}/${PATH}`);
  assert.deepEqual(calls[1].options.headers, { accept: 'application/octet-stream', 'accept-encoding': 'identity' });
});

test('snapshot raw transport cancellation closes a stalled body and propagates request errors', async (t) => {
  const controller = new AbortController();
  let supplied;
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  t.mock.method(https, 'get', (url, options, callback) => {
    const request = new EventEmitter();
    if (supplied) {
      queueMicrotask(() => request.emit('error', new Error('controlled TLS failure')));
      return request;
    }
    const body = new Readable({ read() { start(); } });
    body.statusCode = 200;
    body.headers = { 'content-length': '1' };
    supplied = { body, options };
    options.signal.addEventListener('abort', () => body.destroy(), { once: true });
    queueMicrotask(() => callback(body));
    return request;
  });
  const source = new UbuntuSnapshotArchiveHttpsSource({
    baseUrl: 'https://snapshot.example.invalid/ubuntu/', snapshot: SNAPSHOT, maxDurationMs: 1_000,
    timeoutSignal: inertTimeout(),
  });
  const pending = source.read({ path: PATH, maximum: 1, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(() => pending, (error) => error.name === 'AbortError');
  assert.equal(supplied.body.destroyed, true);
  assert.equal(supplied.options.signal.aborted, true);
  await assert.rejects(() => source.read({ path: PATH, maximum: 1 }), /controlled TLS failure/u);
});

test('snapshot response admission finalizes transport on header and body errors', async () => {
  const cases = [
    { status: 200, headers: { 'content-length': '1, 1' }, bytes: Buffer.from('a'), error: /content length/u },
    { status: 200, headers: { 'content-length': '2' }, bytes: Buffer.from('a'), error: /exceeds its bound/u },
    { status: 200, headers: { 'content-length': '1' }, bytes: Buffer.from('ab'), error: /byte bound/u },
    { status: 200, headers: { 'content-length': '1' }, bytes: Buffer.alloc(0), error: /byte count/u },
  ];
  for (const entry of cases) {
    let observed;
    const source = new UbuntuSnapshotArchiveHttpsSource({
      baseUrl: 'https://snapshot.example.invalid/ubuntu/', snapshot: SNAPSHOT, maxDurationMs: 1_000,
      timeoutSignal: inertTimeout(), fetchImpl: async (url, { signal }) => {
        observed = signal;
        return response(entry.status, entry.bytes, entry.headers);
      },
    });
    await assert.rejects(() => source.read({ path: PATH, maximum: 1 }), entry.error);
    assert.equal(observed.aborted, true);
  }
});
