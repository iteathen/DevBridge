import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GitHubReleaseDestination,
  GITHUB_RELEASE_DESTINATION_PROTOCOL,
} from '../src/release/github-release-destination.mjs';
import { ImmutableReleasePublicationGate } from '../src/release/immutable-release-publication-gate.mjs';
import { IMMUTABLE_OBJECT_SET_PROTOCOL } from '../src/runtime/immutable-object-set.js';

const OWNER = 'iteathen';
const REPOSITORY = 'release-inputs';
const RELEASE_ID = 77;
const API_ASSET = `https://api.github.com/repos/${OWNER}/${REPOSITORY}/releases/assets`;

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function objectName(digest) { return `devbridge-object-${digest}`; }
function authorityName(name) { return `devbridge-authority-${sha256(Buffer.from(name, 'utf8'))}`; }

function json(value, status = 200) {
  const bytes = Buffer.from(JSON.stringify(value));
  return new Response(bytes, { status, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } });
}

function binary(bytes) {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } });
}

async function bodyBytes(body) {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  let total = 0;
  for await (const chunk of body) { chunks.push(Buffer.from(chunk)); total += chunk.length; }
  return Buffer.concat(chunks, total);
}

function githubFake({ initial = [], redirect = false, mutateAfterUpload = null } = {}) {
  const assets = initial.map((asset) => ({ ...asset }));
  const contents = new Map(initial.filter((asset) => asset.bytes != null).map((asset) => [asset.id, Buffer.from(asset.bytes)]));
  for (const asset of assets) delete asset.bytes;
  const calls = [];
  let nextId = Math.max(100, ...assets.map((asset) => asset.id)) + 1;
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({ url: url.href, options });
    if (url.hostname === 'uploads.github.com') {
      const name = url.searchParams.get('name');
      if (assets.some((asset) => asset.name === name)) return json({ message: 'already_exists' }, 422);
      const bytes = await bodyBytes(options.body);
      if (mutateAfterUpload) await mutateAfterUpload();
      const asset = {
        id: nextId++, name, state: 'uploaded', size: bytes.length,
        digest: `sha256:${sha256(bytes)}`, url: `${API_ASSET}/${nextId - 1}`,
      };
      assets.push(asset);
      contents.set(asset.id, bytes);
      return json(asset, 201);
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith(`/releases/${RELEASE_ID}/assets`)) {
      const page = Number(url.searchParams.get('page'));
      const start = (page - 1) * 100;
      return json(assets.slice(start, start + 100));
    }
    const match = url.hostname === 'api.github.com' ? url.pathname.match(/\/releases\/assets\/(\d+)$/u) : null;
    if (match) {
      const id = Number(match[1]);
      if (!contents.has(id)) return json({ message: 'not found' }, 404);
      if (redirect) {
        return new Response(null, {
          status: 302,
          headers: { location: `https://release-assets.githubusercontent.com/github-production-release-asset/${id}` },
        });
      }
      return binary(contents.get(id));
    }
    if (url.hostname === 'release-assets.githubusercontent.com') {
      const id = Number(url.pathname.split('/').at(-1));
      return binary(contents.get(id));
    }
    throw new Error(`unexpected fake GitHub request: ${url.href}`);
  };
  return { assets, calls, contents, fetchImpl };
}

function adapter(fake, overrides = {}) {
  return new GitHubReleaseDestination({
    owner: OWNER,
    repository: REPOSITORY,
    releaseId: RELEASE_ID,
    token: async () => 'test-token',
    maxDurationMs: 10_000,
    fetchImpl: fake.fetchImpl,
    ...overrides,
  });
}

function descriptor(bytes, location) {
  const digest = sha256(bytes);
  const chunk = { ordinal: 0, name: 'payload.000000', offset: 0, size: bytes.length, sha256: digest };
  const object = { name: 'payload.bin', size: bytes.length, sha256: digest, chunks: [chunk] };
  return {
    value: { protocol: IMMUTABLE_OBJECT_SET_PROTOCOL, subject: 'github-release-test', objects: [object] },
    object,
    chunk,
    local: { sha256: digest, size: bytes.length, location },
  };
}

test('GitHub Release destination exposes one exact accepted publication shape', () => {
  const fake = githubFake();
  const selected = adapter(fake);
  assert.equal(selected.protocol, GITHUB_RELEASE_DESTINATION_PROTOCOL);
  assert.match(selected.identity, /^github-release:[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(selected.asPublicationDestination()), ['identity', 'objects', 'source', 'authority']);
  assert.throws(() => adapter(fake, { latest: true }), /latest is unsupported/u);
  assert.throws(() => adapter(fake, { releaseId: '77' }), /release identity/u);
  assert.throws(() => adapter(fake, { maxDurationMs: 999 }), /duration/u);
});

test('GitHub Release destination uploads an exact object once and streams it back by numeric asset id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-github-release-object-'));
  try {
    const bytes = Buffer.from('exact release object');
    const location = path.join(root, 'object');
    await writeFile(location, bytes);
    const release = descriptor(bytes, location);
    const fake = githubFake();
    const selected = adapter(fake);
    await selected.ensureObject(release.local);
    await selected.ensureObject(release.local);
    const response = await selected.fetchObject({
      subject: release.value.subject,
      object: release.object,
      chunk: release.chunk,
    });
    assert.deepEqual(await bodyBytes(response.body), bytes);
    assert.equal(fake.calls.filter((call) => call.url.startsWith('https://uploads.github.com/')).length, 1);
    assert.equal(fake.assets[0].name, objectName(release.chunk.sha256));
    assert.match(fake.calls.at(-1).url, /\/releases\/assets\/101$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('GitHub Release destination composes with authority-last publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-github-release-gate-'));
  try {
    const bytes = Buffer.from('published release object');
    const location = path.join(root, 'object');
    await writeFile(location, bytes);
    const release = descriptor(bytes, location);
    const fake = githubFake();
    const selected = adapter(fake);
    const prerequisite = { name: 'release-key.pem', bytes: Buffer.from('public key') };
    const commit = { name: 'manifest.json', bytes: Buffer.from('signed manifest') };
    const receipt = await new ImmutableReleasePublicationGate({
      destinations: [selected.asPublicationDestination()],
    }).publish({
      descriptors: [release.value],
      objects: [release.local],
      authorityPrerequisites: [prerequisite],
      authorityCommit: commit,
    });
    assert.deepEqual(receipt.destinations, [{ identity: selected.identity }]);
    const uploadedNames = fake.calls
      .filter((call) => call.url.startsWith('https://uploads.github.com/'))
      .map((call) => new URL(call.url).searchParams.get('name'));
    assert.deepEqual(uploadedNames, [
      objectName(release.chunk.sha256),
      authorityName(prerequisite.name),
      authorityName(commit.name),
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('GitHub Release destination validates one storage redirect and strips credentials', async () => {
  const bytes = Buffer.from('redirected object');
  const digest = sha256(bytes);
  const asset = {
    id: 9, name: objectName(digest), state: 'uploaded', size: bytes.length,
    digest: `sha256:${digest}`, url: `${API_ASSET}/9`, bytes,
  };
  const fake = githubFake({ initial: [asset], redirect: true });
  const selected = adapter(fake);
  const release = descriptor(bytes, 'unused');
  const response = await selected.fetchObject({ subject: release.value.subject, object: release.object, chunk: release.chunk });
  assert.deepEqual(await bodyBytes(response.body), bytes);
  const redirected = fake.calls.find((call) => call.url.startsWith('https://release-assets.githubusercontent.com/'));
  assert.ok(redirected);
  assert.equal(Object.hasOwn(redirected.options.headers, 'authorization'), false);
});

test('GitHub Release destination observes an existing exact asset through bounded pagination', async () => {
  const bytes = Buffer.from('existing paginated object');
  const digest = sha256(bytes);
  const padding = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `padding-${String(index).padStart(3, '0')}`,
    state: 'uploaded',
    size: 1,
    digest: null,
    url: `${API_ASSET}/${index + 1}`,
    bytes: Buffer.from('x'),
  }));
  const existing = {
    id: 200, name: objectName(digest), state: 'uploaded', size: bytes.length,
    digest: `sha256:${digest}`, url: `${API_ASSET}/200`, bytes,
  };
  const fake = githubFake({ initial: [...padding, existing] });
  const selected = adapter(fake);
  const release = descriptor(bytes, 'unused');
  await selected.ensureObject({ ...release.local, location: path.resolve('unused-existing-object') });
  const response = await selected.fetchObject({ subject: release.value.subject, object: release.object, chunk: release.chunk });
  assert.deepEqual(await bodyBytes(response.body), bytes);
  assert.equal(fake.calls.filter((call) => call.url.includes('/assets?per_page=100&page=')).length, 2);
  assert.equal(fake.calls.some((call) => call.url.startsWith('https://uploads.github.com/')), false);
});

test('GitHub Release destination rejects conflicting and incomplete existing assets without mutation', async () => {
  const bytes = Buffer.from('expected');
  const digest = sha256(bytes);
  const wrong = {
    id: 12, name: objectName(digest), state: 'starter', size: 0,
    digest: null, url: `${API_ASSET}/12`, bytes: Buffer.alloc(0),
  };
  const fake = githubFake({ initial: [wrong] });
  const selected = adapter(fake);
  await assert.rejects(selected.ensureObject({ sha256: digest, size: bytes.length, location: 'C:\\not-used' }), /metadata does not match/u);
  assert.equal(fake.calls.some((call) => call.url.startsWith('https://uploads.github.com/')), false);
});

test('GitHub Release destination detects a local object changed during upload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-github-release-mutation-'));
  try {
    const bytes = Buffer.from('before mutation');
    const location = path.join(root, 'object');
    await writeFile(location, bytes);
    const fake = githubFake({ mutateAfterUpload: () => writeFile(location, Buffer.from('after-mutation')) });
    await assert.rejects(adapter(fake).ensureObject({ sha256: sha256(bytes), size: bytes.length, location }), /changed while uploading/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('GitHub Release destination requires a bounded credential and rejects unapproved redirects', async () => {
  const bytes = Buffer.from('redirect policy');
  const digest = sha256(bytes);
  const asset = {
    id: 20, name: objectName(digest), state: 'uploaded', size: bytes.length,
    digest: `sha256:${digest}`, url: `${API_ASSET}/20`, bytes,
  };
  const missing = githubFake({ initial: [asset] });
  const noCredential = adapter(missing, { token: async () => null });
  const release = descriptor(bytes, 'unused');
  await assert.rejects(noCredential.fetchObject({ subject: release.value.subject, object: release.object, chunk: release.chunk }), /credential is unavailable/u);

  const badRedirect = githubFake({ initial: [asset] });
  badRedirect.fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith(`/releases/${RELEASE_ID}/assets`)) return json(badRedirect.assets);
    if (/\/releases\/assets\/20$/u.test(url.pathname)) {
      return new Response(null, { status: 302, headers: { location: 'https://example.invalid/stolen' } });
    }
    return githubFake().fetchImpl(rawUrl, options);
  };
  await assert.rejects(adapter(badRedirect).fetchObject({
    subject: release.value.subject,
    object: release.object,
    chunk: release.chunk,
  }), /left the approved storage boundary/u);
});

test('GitHub Release destination remains provider-specific without setup or construction authority', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(
    new URL('../src/release/github-release-destination.mjs', import.meta.url), 'utf8',
  ));
  for (const forbidden of ['setup --construct', 'Start-VM', 'Hyper-V', 'libvirt', 'snapshot.ubuntu.com', 'sudo', 'RunAs']) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'iu'));
  }
  assert.match(source, /releaseId/u);
  assert.match(source, /redirect: 'manual'/u);
});
