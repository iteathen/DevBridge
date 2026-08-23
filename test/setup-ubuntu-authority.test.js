import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createUbuntuSetupAuthority, defaultUbuntuPackageSnapshot, resolveUbuntuPackagePins } from '../src/setup/ubuntu-authority.js';

const SNAPSHOT = '20260821T200000Z';

function index(entries) {
  return gzipSync(Buffer.from(entries.map(([name, version]) => `Package: ${name}\nVersion: ${version}\nArchitecture: amd64\n`).join('\n'), 'utf8'));
}

function responseFor(url) {
  const body = url.includes('/main/')
    ? index([['build-essential', '12.12ubuntu1'], ['cmake', '3.31.6-1'], ['git', '1:2.48.1-0ubuntu1']])
    : index([['nodejs', '22.16.0+dfsg-1'], ['npm', '10.9.2+ds-1']]);
  return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
}

test('setup snapshot choice is exact and deliberately lagged from the current clock', () => {
  assert.equal(defaultUbuntuPackageSnapshot(new Date('2026-08-23T20:45:00Z')), SNAPSHOT);
});

test('setup resolves every required package from the exact snapshot without fixture pins', async () => {
  const requests = [];
  const packages = await resolveUbuntuPackagePins({
    snapshot: SNAPSHOT,
    fetchImpl: async (url) => { requests.push(String(url)); return responseFor(String(url)); },
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.includes(`/${SNAPSHOT}/dists/resolute/`)));
  assert.deepEqual(packages, [
    { name: 'build-essential', version: '12.12ubuntu1' },
    { name: 'cmake', version: '3.31.6-1' },
    { name: 'git', version: '1:2.48.1-0ubuntu1' },
    { name: 'nodejs', version: '22.16.0+dfsg-1' },
    { name: 'npm', version: '10.9.2+ds-1' },
  ]);
});

test('setup authority binds source policy, exact snapshot and current payload generation', async () => {
  const authority = await createUbuntuSetupAuthority({
    snapshot: SNAPSHOT,
    fetchImpl: async (url) => responseFor(String(url)),
    payloadFactory: async () => ({ generation: 'guest-image-current' }),
  });
  assert.equal(authority.source.media.sha256, 'dec49008a71f6098d0bcfc822021f4d042d5f2db279e4d75bdd981304f1ca5d9');
  assert.equal(authority.source.media.bytes, 2_918_598_656);
  assert.equal(authority.packages.snapshot, SNAPSHOT);
  assert.equal(authority.payload.generation, 'guest-image-current');
  assert.deepEqual(authority.recipe.patches, [{ id: 'boot-trigger', occurrences: 2, before: 'install ---', after: 'auto    ---' }]);
});

test('setup package resolution fails closed when the snapshot is incomplete', async () => {
  await assert.rejects(
    () => resolveUbuntuPackagePins({ snapshot: SNAPSHOT, fetchImpl: async () => new Response(index([['git', '1:2.48.1-0ubuntu1']]), { status: 200 }) }),
    /does not contain required setup packages/u,
  );
});
