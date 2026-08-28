import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageLibraryAdoption, IMAGE_LIBRARY_ADOPTION_PROTOCOL } from '../src/setup/image-library-adoption.js';

const EXPECTED = Object.freeze({
  identity: 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  profile: 'linux-development',
  generation: 'ubuntu-production-v1',
  digest: 'b'.repeat(64),
  size: 4096,
  media: Object.freeze({ format: 'vhdx', contentIdentity: 'DISK-A', parentIdentity: null, virtualSize: 32768 }),
  provenance: Object.freeze({ origin: 'fixture', source: 'authority-a' }),
  retiredAt: null,
});

function fixtures({ destinationEntries = [], published = EXPECTED, verificationMedia = EXPECTED.media, sourceVerified = true } = {}) {
  const calls = [];
  const source = Object.freeze({
    async reconcile() { calls.push('source-reconcile'); },
    async list() { calls.push('source-list'); return [EXPECTED]; },
    async observe(identity) {
      calls.push(`source-observe:${identity}`);
      return { identity, exists: true, usable: true, location: 'C:\\fixed\\source.vhdx' };
    },
    async verify(identity) { calls.push(`source-verify:${identity}`); return { identity, usable: sourceVerified, verified: sourceVerified }; },
  });
  const destination = Object.freeze({
    async reconcile() { calls.push('destination-reconcile'); },
    async list() { calls.push('destination-list'); return destinationEntries; },
    async verify(identity) { calls.push(`destination-verify:${identity}`); return { identity, usable: true, verified: true, media: verificationMedia }; },
    async publish(request) { calls.push(['destination-publish', request]); return published; },
  });
  return { calls, source, destination };
}

test('adoption reconciles both sides, publishes one exact generation, and verifies the destination', async () => {
  const fixture = fixtures();
  const result = await createImageLibraryAdoption(fixture).reconcile();
  assert.deepEqual(result, {
    protocol: IMAGE_LIBRARY_ADOPTION_PROTOCOL,
    ready: true,
    changed: true,
    adopted: [EXPECTED.identity],
  });
  assert.deepEqual(fixture.calls.slice(0, 4), ['source-reconcile', 'destination-reconcile', 'source-list', 'destination-list']);
  const publish = fixture.calls.find((entry) => Array.isArray(entry));
  assert.deepEqual(publish[1], {
    profile: EXPECTED.profile,
    generation: EXPECTED.generation,
    source: 'C:\\fixed\\source.vhdx',
    provenance: EXPECTED.provenance,
    expectedDigest: EXPECTED.digest,
  });
  assert.equal(fixture.calls.at(-1), `destination-verify:${EXPECTED.identity}`);
});

test('an exact verified destination is idempotent and performs no publication', async () => {
  const fixture = fixtures({ destinationEntries: [EXPECTED] });
  const result = await createImageLibraryAdoption(fixture).reconcile();
  assert.equal(result.changed, false);
  assert.deepEqual(result.adopted, [EXPECTED.identity]);
  assert.equal(fixture.calls.some((entry) => Array.isArray(entry)), false);
});

test('a conflicting immutable generation fails before publication', async () => {
  const fixture = fixtures({ destinationEntries: [{ ...EXPECTED, identity: 'img-cccccccccccccccccccccccccccccccc', digest: 'd'.repeat(64) }] });
  await assert.rejects(() => createImageLibraryAdoption(fixture).reconcile(), /conflicting immutable generation/u);
  assert.equal(fixture.calls.some((entry) => Array.isArray(entry)), false);
});

test('provider-observed destination media must preserve the recorded parent-free identity', async () => {
  const fixture = fixtures({ verificationMedia: { ...EXPECTED.media, contentIdentity: 'DISK-B' } });
  await assert.rejects(() => createImageLibraryAdoption(fixture).reconcile(), /media identity changed/u);
});

test('unverified source state fails closed without invoking destination publication', async () => {
  const fixture = fixtures({ sourceVerified: false });
  await assert.rejects(() => createImageLibraryAdoption(fixture).reconcile(), /source verification failed/u);
  assert.equal(fixture.calls.some((entry) => Array.isArray(entry)), false);
});
