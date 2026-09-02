import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  SOURCE_BUNDLE_FORMAT,
  SOURCE_BUNDLE_REPOSITORY,
  sourceBundleReleasePayload,
  verifySourceBundleReleaseInput,
} from '../src/bootstrap/source-bundle-release-input.mjs';
import { sourceBundleAuthority } from './fixtures/source-bundle-fixture.js';

test('signed source-bundle authority binds exact repository, commit, tree, format, and immutable object', () => {
  const fixture = sourceBundleAuthority();
  const accepted = verifySourceBundleReleaseInput(fixture.authority);
  assert.equal(accepted.repository, SOURCE_BUNDLE_REPOSITORY);
  assert.equal(accepted.head, fixture.head);
  assert.equal(accepted.tree, fixture.tree);
  assert.equal(accepted.format, SOURCE_BUNDLE_FORMAT);
  assert.equal(accepted.descriptor.objects.length, 1);
  assert.equal(accepted.descriptor.objects[0].sha256, fixture.objectSha256);
  assert.equal(accepted.manifestSha256, fixture.authority.expectedManifestSha256);
  assert.equal(accepted.publicKeySha256, fixture.authority.expectedPublicKeySha256);
});

test('source-bundle authority rejects pinned-byte, signature, subject, and inventory changes', () => {
  const fixture = sourceBundleAuthority();
  assert.throws(() => verifySourceBundleReleaseInput({
    ...fixture.authority,
    expectedManifestSha256: '0'.repeat(64),
  }), /manifest digest/u);
  assert.throws(() => verifySourceBundleReleaseInput({
    ...fixture.authority,
    expectedPublicKeySha256: '0'.repeat(64),
  }), /public-key digest/u);
  assert.throws(() => verifySourceBundleReleaseInput({
    ...fixture.authority,
    expectedKeyId: 'another-key',
  }), /key identity/u);

  const parsed = JSON.parse(fixture.authority.manifestBytes);
  parsed.release.tree = 'c'.repeat(40);
  const tampered = Buffer.from(JSON.stringify(parsed));
  assert.throws(() => verifySourceBundleReleaseInput({
    ...fixture.authority,
    manifestBytes: tampered,
    expectedManifestSha256: createHash('sha256').update(tampered).digest('hex'),
  }), /signature verification/u);
  assert.throws(() => sourceBundleReleasePayload({ ...fixture.release, origin: 'https://example.invalid/' }), /origin is unsupported/u);
  assert.throws(() => sourceBundleReleasePayload({
    ...fixture.release,
    descriptor: { ...fixture.descriptor, objects: [...fixture.descriptor.objects, fixture.descriptor.objects[0]] },
  }), /exactly one|unique/u);
});

test('source-bundle release child remains free of origin, path, setup, package, and provider topology', async () => {
  const source = await readFile(new URL('../src/bootstrap/source-bundle-release-input.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['snapshot.ubuntu.com', 'raw.githubusercontent.com', 'Hyper-V', 'libvirt', 'setup --construct', 'package capsule']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(source, /(?:origin|cache|destination|localPath):/u);
});

test('source-bundle core depends on local acquisition and materialization studs rather than consumer topology', async () => {
  const materialization = await readFile(new URL('../src/bootstrap/source-bundle-materialization.mjs', import.meta.url), 'utf8');
  const availability = await readFile(new URL('../src/bootstrap/source-bundle-availability.mjs', import.meta.url), 'utf8');
  for (const source of [materialization, availability]) {
    for (const forbidden of ['GitHubRunnerSource', 'ExactCheckoutRunnerProvider', 'prepareRuntimeCandidate', 'Permanent Entry', 'snapshot.ubuntu.com', 'Hyper-V', 'libvirt']) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  }
  assert.match(materialization, /acquisition\.ensure/u);
  assert.match(materialization, /checkout\.materialize/u);
});
