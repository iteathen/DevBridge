import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_BYTE_MANIFEST_PROTOCOL,
  FIRST_BYTE_REPOSITORY,
  firstByteReleasePayload,
  verifyFirstByteReleaseInput,
} from '../src/bootstrap/first-byte-release-input.mjs';
import { BYTES, HEAD, PUBLIC_KEY, authority, descriptor, manifestBytes, release, sha256 } from './fixtures/first-byte-fixture.js';

test('signed first-byte authority binds exact release, key, manifest, and immutable bootstrap object', () => {
  const bytes = manifestBytes();
  const verified = verifyFirstByteReleaseInput(authority(bytes));
  assert.equal(verified.repository, FIRST_BYTE_REPOSITORY);
  assert.equal(verified.head, HEAD);
  assert.equal(verified.releaseId, 'stage8-first-byte-1');
  assert.equal(verified.sequence, 1);
  assert.equal(verified.keyId, 'release-test-key');
  assert.equal(verified.manifestSha256, sha256(bytes));
  assert.equal(verified.publicKeySha256, sha256(PUBLIC_KEY));
  assert.equal(verified.descriptor.subject, `devbridge-first-byte-${HEAD}`);
  assert.equal(verified.descriptor.objects[0].name, 'bootstrap-devbridge.mjs');
  assert.equal(verified.descriptor.objects[0].sha256, sha256(BYTES));
});

test('first-byte authority rejects manifest, public-key, key-id, signature, and descriptor drift', () => {
  const clean = manifestBytes();
  assert.throws(() => verifyFirstByteReleaseInput(authority(clean, { expectedManifestSha256: 'b'.repeat(64) })), /manifest digest/u);
  assert.throws(() => verifyFirstByteReleaseInput(authority(clean, { expectedPublicKeySha256: 'b'.repeat(64) })), /public-key digest/u);
  assert.throws(() => verifyFirstByteReleaseInput(authority(clean, { expectedKeyId: 'other-key' })), /key identity/u);

  const parsed = JSON.parse(clean.toString('utf8'));
  parsed.release.descriptor.objects[0].sha256 = 'c'.repeat(64);
  const tampered = Buffer.from(JSON.stringify(parsed), 'utf8');
  assert.throws(() => verifyFirstByteReleaseInput(authority(tampered, { expectedManifestSha256: sha256(tampered) })), /signature verification/u);

  parsed.signature.value = `${parsed.signature.value.slice(0, -2)}AA`;
  const badSignature = Buffer.from(JSON.stringify(parsed), 'utf8');
  assert.throws(() => verifyFirstByteReleaseInput(authority(badSignature, { expectedManifestSha256: sha256(badSignature) })), /signature/u);
});

test('signed first-byte authority is deliberately narrower than a general release manifest', () => {
  const second = { ...descriptor().objects[0], name: 'helper.mjs' };
  assert.throws(() => firstByteReleasePayload(release({ descriptor: { ...descriptor(), objects: [...descriptor().objects, second] } })), /exactly one/u);
  assert.throws(() => firstByteReleasePayload(release({ descriptor: { ...descriptor(), subject: 'other-subject' } })), /subject/u);
  assert.throws(() => firstByteReleasePayload(release({ descriptor: { ...descriptor(), objects: [{ ...descriptor().objects[0], name: 'install-devbridge.mjs' }] } })), /bootstrap object/u);
  assert.throws(() => firstByteReleasePayload({ ...release(), origin: 'https://example.invalid/' }), /origin is unsupported/u);
  assert.throws(() => firstByteReleasePayload(release({ repository: 'other/repository' })), /repository/u);
  assert.throws(() => firstByteReleasePayload(release({ head: 'main' })), /exact 40-hex/u);
});
