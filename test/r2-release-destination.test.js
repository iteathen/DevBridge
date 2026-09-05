import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { R2ReleaseDestination } from '../src/release/r2-release-destination.mjs';
import { signS3RequestHeaders } from '../src/release/s3-request-signature.mjs';
import { ImmutableReleasePublicationGate } from '../src/release/immutable-release-publication-gate.mjs';
import { IMMUTABLE_OBJECT_SET_PROTOCOL } from '../src/runtime/immutable-object-set.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const accountId = 'a'.repeat(32), bucket = 'release-test';
const credentials = () => ({ accessKeyId: 'b'.repeat(32), secretAccessKey: 'c'.repeat(64) });
const publicBaseUrl = 'https://downloads.example.test';
const authorityKey = (name, release = 'release-1') => `releases/${release}/${sha(Buffer.from(name))}`;
const options = (extra = {}) => ({ accountId, bucket, releaseId: 'release-1', credentials, publicBaseUrl, maxDurationMs: 1000, ...extra });
async function bytes(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function fixture(data = Buffer.from('immutable release bytes'), location = path.resolve('not-used')) {
  const chunk = { ordinal: 0, name: 'payload.000000', offset: 0, size: data.length, sha256: sha(data) };
  const object = { name: 'payload.bin', size: data.length, sha256: sha(data), chunks: [chunk] };
  return { data, descriptor: { protocol: IMMUTABLE_OBJECT_SET_PROTOCOL, subject: 'r2-test', objects: [object] }, request: { subject: 'r2-test', object, chunk }, local: { sha256: sha(data), size: data.length, location } };
}
function fake({ hook = null, mutate = null, conflict = false } = {}) {
  const objects = new Map(), calls = [];
  const fetchImpl = async (raw, init) => {
    const url = new URL(raw), authenticated = url.hostname.endsWith('.r2.cloudflarestorage.com');
    const key = authenticated ? url.pathname.slice(bucket.length + 2) : url.pathname.slice(1);
    calls.push({ url, init, key, authenticated });
    assert.equal(init.redirect, 'error');
    if (authenticated) assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/u);
    else assert.equal(init.headers.authorization, undefined);
    const override = await hook?.({ url, init, key, authenticated, objects });
    if (override != null) return override;
    if (init.method === 'HEAD') return new Response(null, { status: objects.has(key) ? 200 : 404, headers: objects.has(key) ? { 'content-length': String(objects.get(key).length) } : {} });
    if (init.method === 'PUT') {
      assert.equal(init.headers['if-none-match'], '*');
      if (objects.has(key)) return new Response(null, { status: 412 });
      const data = init.body instanceof Uint8Array ? Buffer.from(init.body) : await bytes(init.body);
      assert.equal(sha(data), init.headers['x-amz-content-sha256']);
      assert.equal(String(data.length), init.headers['content-length']);
      objects.set(key, data);
      await mutate?.();
      return new Response(null, { status: conflict ? 412 : 200 });
    }
    assert.equal(init.method, 'GET');
    const data = objects.get(key);
    return data ? new Response(data, { headers: { 'content-length': String(data.length) } }) : new Response(null, { status: 404 });
  };
  return { objects, calls, fetchImpl };
}
async function withFile(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-r2-release-'));
  try {
    const f = fixture(undefined, path.join(root, 'payload'));
    await writeFile(f.local.location, f.data);
    return await action(f, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('S3 signer matches AWS published GET and PUT signed-payload vectors', () => {
  const shared = { region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z'), accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
  const get = signS3RequestHeaders({ ...shared, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { range: 'bytes=0-9', 'x-amz-content-sha256': sha('') } });
  assert.ok(get.authorization.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'));
  const put = signS3RequestHeaders({ ...shared, method: 'PUT', url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'), headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': sha('Welcome to Amazon S3.') } });
  assert.ok(put.authorization.endsWith('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'));
  assert.throws(() => signS3RequestHeaders({ ...shared, method: 'DELETE', url: new URL(publicBaseUrl), headers: {} }), /invalid/u);
});

test('R2 destination validates exact configuration and request shapes before effects', async () => {
  for (const change of [{ accountId: '../escape' }, { bucket: 'bad/bucket' }, { releaseId: '../release' }, { maxDurationMs: 999 }, { maxDurationMs: 7200001 }, { publicBaseUrl: 'http://example.test' }, { publicBaseUrl: 'https://secret@example.test' }, { publicBaseUrl: `${publicBaseUrl}/subdir` }, { publicBaseUrl: `${publicBaseUrl}?token=no` }, { token: 'unsupported' }, { credentials: null }]) assert.throws(() => new R2ReleaseDestination(options(change)), /invalid/u);
  let effects = 0;
  const adapter = new R2ReleaseDestination(options({ fetchImpl: () => { effects++; } }));
  assert.match(adapter.identity, /^r2-release:[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(adapter.asPublicationDestination()), ['identity', 'objects', 'source', 'authority']);
  const f = fixture();
  for (const change of [{ size: 0 }, { sha256: 'bad' }, { location: 'relative' }, { credential: 'unsupported' }, { signal: {} }]) await assert.rejects(adapter.ensureObject({ ...f.local, ...change }), /invalid/u);
  await assert.rejects(adapter.fetchObject({ ...f.request, url: publicBaseUrl }), /not allowed/u);
  assert.equal(effects, 0);
});

test('R2 uploads through conditional S3, deduplicates, and reads publicly without credentials', async () => withFile(async (f) => {
  const server = fake(), adapter = new R2ReleaseDestination(options({ fetchImpl: server.fetchImpl }));
  await adapter.ensureObject(f.local);
  await adapter.ensureObject(f.local);
  assert.deepEqual(await bytes((await adapter.fetchObject(f.request)).body), f.data);
  assert.equal(server.calls.filter(c => c.init.method === 'PUT').length, 1);
  assert.equal(server.calls.at(-1).authenticated, false);
  assert.equal(server.calls.at(-1).key, `objects/${sha(f.data)}`);
  const reader = new R2ReleaseDestination(options({ fetchImpl: server.fetchImpl, credentials: () => { throw new Error('must not request credentials'); } }));
  assert.deepEqual(await bytes((await reader.fetchObject(f.request)).body), f.data);
}));

test('R2 authority keys are release-scoped and exact read-back rejects substitution', async () => {
  const server = fake(), adapter = new R2ReleaseDestination(options({ fetchImpl: server.fetchImpl }));
  const data = Buffer.from('signed manifest'), request = { name: 'manifest.json', bytes: data, size: data.length, sha256: sha(data) };
  await adapter.ensureAuthority(request);
  const { bytes: ignored, ...read } = request;
  assert.deepEqual(await adapter.readAuthority(read), data);
  assert.ok(server.objects.has(authorityKey(request.name)));
  const other = new R2ReleaseDestination(options({ fetchImpl: server.fetchImpl, releaseId: 'release-2' }));
  await assert.rejects(other.readAuthority(read), /404/u);
  server.objects.set(authorityKey(request.name), Buffer.alloc(data.length));
  await assert.rejects(adapter.readAuthority(read), /do not match/u);
  await assert.rejects(adapter.ensureAuthority({ ...request, bytes: Buffer.alloc(data.length) }), /do not match/u);
});

test('R2 conditional conflict is reobserved without a second PUT', async () => withFile(async (f) => {
  const server = fake({ conflict: true }), adapter = new R2ReleaseDestination(options({ fetchImpl: server.fetchImpl }));
  await adapter.ensureObject(f.local);
  assert.deepEqual(await bytes((await adapter.fetchObject(f.request)).body), f.data);
  assert.equal(server.calls.filter(c => c.init.method === 'PUT').length, 1);
}));

test('R2 restart observes an ambiguous completed upload without replay', async () => withFile(async (f) => {
  let lost = false;
  const server = fake({ mutate: () => { if (!lost) { lost = true; throw new Error('response lost'); } } });
  await assert.rejects(new R2ReleaseDestination(options({ fetchImpl: server.fetchImpl })).ensureObject(f.local), /HTTP request failed/u);
  const restarted = new R2ReleaseDestination(options({ fetchImpl: server.fetchImpl }));
  await restarted.ensureObject(f.local);
  assert.deepEqual(await bytes((await restarted.fetchObject(f.request)).body), f.data);
  assert.equal(server.calls.filter(c => c.init.method === 'PUT').length, 1);
}));

test('R2 rejects hardlinks, wrong local digests, upload mutation, and existing size conflicts', async () => withFile(async (f, root) => {
  const server = fake(), adapter = new R2ReleaseDestination(options({ fetchImpl: server.fetchImpl }));
  await link(f.local.location, path.join(root, 'second-link'));
  await assert.rejects(adapter.ensureObject(f.local), /single-link/u);
  await rm(path.join(root, 'second-link'));
  await assert.rejects(adapter.ensureObject({ ...f.local, sha256: 'd'.repeat(64) }), /identity mismatch/u);
  assert.equal(server.calls.some(c => c.init.method === 'PUT'), false);
  const mutating = fake({ mutate: () => writeFile(f.local.location, Buffer.alloc(f.data.length)) });
  await assert.rejects(new R2ReleaseDestination(options({ fetchImpl: mutating.fetchImpl })).ensureObject(f.local), /changed while uploading/u);
  server.objects.set(`objects/${sha(f.data)}`, Buffer.from('wrong size'));
  await assert.rejects(adapter.ensureObject(f.local), /length or representation/u);
}));

test('R2 refuses redirects, changed representation, short, oversized, and corrupt bodies', async () => {
  const f = fixture();
  const responses = [
    () => new Response(null, { status: 302, headers: { location: 'https://other.test' } }),
    () => new Response(f.data, { headers: { 'content-length': String(f.data.length), 'content-encoding': 'gzip' } }),
    () => new Response(f.data, { headers: { 'content-length': String(f.data.length), 'content-range': 'bytes 0-1/2' } }),
    () => new Response(f.data),
    () => new Response(f.data.subarray(1), { headers: { 'content-length': String(f.data.length) } }),
    () => new Response(Buffer.concat([f.data, f.data]), { headers: { 'content-length': String(f.data.length) } }),
    () => new Response(Buffer.alloc(f.data.length), { headers: { 'content-length': String(f.data.length) } }),
  ];
  for (const response of responses) {
    const adapter = new R2ReleaseDestination(options({ fetchImpl: async () => response() }));
    await assert.rejects(async () => bytes((await adapter.fetchObject(f.request)).body), /R2/u);
  }
});

test('R2 pending credentials, fetch, and body reads honor cancellation without leaking errors', { timeout: 2000 }, async () => {
  const f = fixture();
  for (const stage of ['credential', 'fetch', 'body']) {
    const abort = new AbortController();
    const pending = () => { setImmediate(() => abort.abort('sensitive reason')); return new Promise(() => {}); };
    const adapter = new R2ReleaseDestination(options({
      credentials: stage === 'credential' ? pending : credentials,
      fetchImpl: stage === 'fetch' ? pending : async () => ({ status: 200, headers: new Headers({ 'content-length': String(f.data.length) }), body: { [Symbol.asyncIterator]() { return { next: pending, return: async () => ({ done: true }) }; } } }),
    }));
    await assert.rejects(stage === 'credential' ? adapter.ensureObject({ ...f.local, signal: abort.signal }) : (async () => bytes((await adapter.fetchObject({ ...f.request, signal: abort.signal })).body))(), error => error.name === 'AbortError' && !error.message.includes('sensitive'));
  }
  const adapter = new R2ReleaseDestination(options({ credentials: async () => { throw new Error('secret-value'); } }));
  await assert.rejects(adapter.ensureObject(f.local), e => !e.message.includes('secret-value'));
});

test('R2 operation timeout and pre-abort stop work, including a late HTTP response', { timeout: 2000 }, async () => {
  const f = fixture(), pre = new AbortController(); pre.abort();
  let calls = 0;
  const disabled = new R2ReleaseDestination(options({ fetchImpl: () => { calls++; } }));
  await assert.rejects(disabled.fetchObject({ ...f.request, signal: pre.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const timeout = new AbortController(); let finish, cancelled = false;
  const adapter = new R2ReleaseDestination(options({ timeoutSignal: () => timeout.signal, fetchImpl: () => new Promise(resolve => { finish = resolve; setImmediate(() => timeout.abort()); }) }));
  await assert.rejects(adapter.fetchObject(f.request), { name: 'AbortError' });
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(f.data.length) } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('R2 rejects indirect parent directories without uploading', async () => withFile(async (f, root) => {
  const alias = path.join(root, 'alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const server = fake(), adapter = new R2ReleaseDestination(options({ fetchImpl: server.fetchImpl }));
  await assert.rejects(adapter.ensureObject({ ...f.local, location: path.join(alias, 'payload') }), /must be direct/u);
  assert.equal(server.calls.some(c => c.init.method === 'PUT'), false);
}));

test('R2 rejects invalid credentials, transport identity, rate limits, and absent post-PUT state', async () => withFile(async (f) => {
  for (const supplied of [{ accessKeyId: 'bad', secretAccessKey: 'c'.repeat(64) }, { ...credentials(), token: 'extra' }]) {
    let calls = 0;
    const adapter = new R2ReleaseDestination(options({ credentials: () => supplied, fetchImpl: () => { calls++; } }));
    await assert.rejects(adapter.ensureObject(f.local), /invalid/u); assert.equal(calls, 0);
  }
  for (const status of [401, 403, 429, 503]) {
    let calls = 0;
    const adapter = new R2ReleaseDestination(options({ fetchImpl: async () => { calls++; return new Response(null, { status }); } }));
    await assert.rejects(adapter.ensureObject(f.local), new RegExp(String(status))); assert.equal(calls, 1);
  }
  const identity = new R2ReleaseDestination(options({ fetchImpl: async () => ({ status: 200, redirected: true }) }));
  await assert.rejects(identity.fetchObject(f.request), /identity/u);
  const absent = fake({ hook: ({ init }) => init.method === 'PUT' ? new Response(null, { status: 200 }) : null });
  await assert.rejects(new R2ReleaseDestination(options({ fetchImpl: absent.fetchImpl })).ensureObject(f.local), /not observed/u);
}));

test('R2 composes through the neutral gate and publishes authority only after replica verification', async () => withFile(async (f) => {
  const server = fake(), adapter = new R2ReleaseDestination(options({ fetchImpl: server.fetchImpl }));
  const request = { descriptors: [f.descriptor], objects: [f.local], authorityPrerequisites: [{ name: 'key.pem', bytes: Buffer.from('public-key') }], authorityCommit: { name: 'manifest.json', bytes: Buffer.from('signed-manifest') } };
  await new ImmutableReleasePublicationGate({ destinations: [adapter.asPublicationDestination()] }).publish(request);
  assert.deepEqual(server.calls.filter(c => c.init.method === 'PUT').map(c => c.key), [`objects/${sha(f.data)}`, authorityKey('key.pem'), authorityKey('manifest.json')]);
  const failed = fake({ hook: ({ authenticated }) => authenticated ? null : new Response(Buffer.alloc(f.data.length), { headers: { 'content-length': String(f.data.length) } }) });
  const bad = new R2ReleaseDestination(options({ fetchImpl: failed.fetchImpl }));
  await assert.rejects(new ImmutableReleasePublicationGate({ destinations: [bad.asPublicationDestination()] }).publish(request), /do not match/u);
  assert.equal(failed.calls.some(c => c.init.method === 'PUT' && c.key.startsWith('releases/')), false);
}));
