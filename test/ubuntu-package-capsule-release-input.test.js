import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  UBUNTU_PACKAGE_CAPSULE_DISTRIBUTION,
  UBUNTU_PACKAGE_CAPSULE_TRANSACTION_PROTOCOL,
  UBUNTU_PACKAGE_STATE_PROTOCOL,
  ubuntuPackageCapsuleReleasePayload,
  verifyUbuntuPackageCapsuleReleaseInput,
} from '../src/setup/ubuntu-package-capsule-release-input.mjs';
import {
  sha256,
  ubuntuPackageCapsuleAuthority,
  ubuntuPackageCapsuleRelease,
} from './fixtures/ubuntu-package-capsule-fixture.js';

function clone(value) { return structuredClone(value); }

function sourceComponentRelease(count) {
  const release = ubuntuPackageCapsuleRelease();
  const source = release.sources.packages[0];
  const template = release.sources.descriptor.objects.find((object) => object.name === source.files[0].object);
  for (let index = 1; index < count; index++) {
    const name = `source-component-${index}`;
    const object = clone(template);
    object.name = name;
    object.chunks[0].name = `${name}.chunk`;
    release.sources.descriptor.objects.push(object);
    source.files.push({ filename: `component-${index}.tar.xz`, object: name });
  }
  return release;
}

test('source component coverage follows the bounded descriptor rather than a 64-file cutoff', () => {
  for (const count of [65, 291]) {
    const release = sourceComponentRelease(count);
    const fixture = ubuntuPackageCapsuleAuthority({ release });
    const accepted = verifyUbuntuPackageCapsuleReleaseInput(fixture.authority);
    assert.equal(accepted.sources.packages[0].files.length, count);
    const reordered = clone(release);
    reordered.sources.packages.reverse();
    reordered.sources.descriptor.objects.reverse();
    for (const source of reordered.sources.packages) source.files.reverse();
    assert.deepEqual(ubuntuPackageCapsuleReleasePayload(reordered), ubuntuPackageCapsuleReleasePayload(release));
  }
  const atLimit = sourceComponentRelease(8185);
  assert.equal(atLimit.sources.descriptor.objects.length, 8192);
  assert.doesNotThrow(() => ubuntuPackageCapsuleReleasePayload(atLimit));
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(sourceComponentRelease(8186)), /objects/u);
});

test('large source inventories retain exact coverage, distinct claims, and descriptor cardinality checks', () => {
  const mutations = [
    [(r) => r.sources.packages[0].files.push(clone(r.sources.packages[0].files[0])), /reuses an immutable object/u],
    [(r) => r.sources.descriptor.objects.pop(), /does not identify a descriptor object/u],
    [(r) => r.sources.packages[0].files.pop(), /exactly cover/u],
    [(r) => { r.sources.packages[0].files = []; }, /files is invalid/u],
    [(r) => { r.sources.packages[0].files = Array(r.sources.descriptor.objects.length).fill(r.sources.packages[0].files[0]); }, /files is invalid/u],
  ];
  for (const [mutate, expected] of mutations) {
    const release = sourceComponentRelease(291);
    mutate(release);
    assert.throws(() => ubuntuPackageCapsuleReleasePayload(release), expected);
  }
});

test('signed Ubuntu package capsule binds exact snapshot, transaction, metadata, binaries, and sources', () => {
  const fixture = ubuntuPackageCapsuleAuthority();
  const accepted = verifyUbuntuPackageCapsuleReleaseInput(fixture.authority);
  assert.equal(accepted.distribution, UBUNTU_PACKAGE_CAPSULE_DISTRIBUTION);
  assert.equal(accepted.snapshot, '20260821T230000Z');
  assert.equal(accepted.baseMediaSha256, 'a'.repeat(64));
  assert.equal(accepted.transaction.protocol, UBUNTU_PACKAGE_CAPSULE_TRANSACTION_PROTOCOL);
  assert.equal(accepted.transaction.packageStateProtocol, UBUNTU_PACKAGE_STATE_PROTOCOL);
  assert.equal(accepted.transaction.basePackageStateSha256, 'b'.repeat(64));
  assert.equal(accepted.transaction.resultPackageStateSha256, 'c'.repeat(64));
  assert.deepEqual(accepted.metadata.pockets.map((entry) => entry.pocket), ['resolute', 'resolute-updates', 'resolute-security']);
  assert.equal(accepted.metadata.descriptor.objects.length, 15);
  assert.equal(accepted.binaries.packages.length, 3);
  assert.equal(accepted.sources.packages.length, 3);
  assert.match(accepted.transactionSha256, /^[a-f0-9]{64}$/u);
  assert.match(accepted.metadata.inventorySha256, /^[a-f0-9]{64}$/u);
  assert.match(accepted.binaries.inventorySha256, /^[a-f0-9]{64}$/u);
  assert.match(accepted.sources.inventorySha256, /^[a-f0-9]{64}$/u);
  assert.equal(accepted.manifestSha256, fixture.authority.expectedManifestSha256);
  assert.equal(accepted.publicKeySha256, fixture.authority.expectedPublicKeySha256);
});

test('Ubuntu package capsule rejects pin, key, signature, and signed-subject drift', () => {
  const fixture = ubuntuPackageCapsuleAuthority();
  assert.throws(() => verifyUbuntuPackageCapsuleReleaseInput({
    ...fixture.authority, expectedManifestSha256: '0'.repeat(64),
  }), /manifest digest/u);
  assert.throws(() => verifyUbuntuPackageCapsuleReleaseInput({
    ...fixture.authority, expectedPublicKeySha256: '0'.repeat(64),
  }), /public-key digest/u);
  assert.throws(() => verifyUbuntuPackageCapsuleReleaseInput({
    ...fixture.authority, expectedKeyId: 'another-key',
  }), /key identity/u);

  const parsed = JSON.parse(fixture.manifestBytes);
  parsed.release.snapshot = '20260822T230000Z';
  const tampered = Buffer.from(JSON.stringify(parsed), 'utf8');
  assert.throws(() => verifyUbuntuPackageCapsuleReleaseInput({
    ...fixture.authority,
    manifestBytes: tampered,
    expectedManifestSha256: createHash('sha256').update(tampered).digest('hex'),
  }), /signature verification/u);
});

test('Ubuntu package capsule enforces fixed metadata topology and exact metadata object coverage', () => {
  const wrongPocket = ubuntuPackageCapsuleRelease();
  wrongPocket.metadata.pockets[0].pocket = 'resolute-backports';
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(wrongPocket), /pocket identity/u);

  const wrongIndex = ubuntuPackageCapsuleRelease();
  wrongIndex.metadata.pockets[0].components[0].binaryIndex.path = 'main/binary-arm64/Packages.xz';
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(wrongIndex), /does not match/u);

  const reused = ubuntuPackageCapsuleRelease();
  reused.metadata.pockets[0].components[0].sourceIndex.object = reused.metadata.pockets[0].components[0].binaryIndex.object;
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(reused), /reuses an immutable object/u);

  const extra = ubuntuPackageCapsuleRelease();
  extra.metadata.descriptor.objects.push(clone(extra.metadata.descriptor.objects[0]));
  extra.metadata.descriptor.objects.at(-1).name = 'unreferenced-metadata';
  extra.metadata.descriptor.objects.at(-1).chunks[0].name = 'unreferenced-metadata.chunk';
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(extra), /exactly cover/u);
});

test('Ubuntu package capsule binds a complete binary transaction with exact object coverage', () => {
  const wrongStateProtocol = ubuntuPackageCapsuleRelease();
  wrongStateProtocol.transaction.packageStateProtocol = 'devbridge/other-package-state-v1';
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(wrongStateProtocol), /package-state protocol/u);

  const widenedTransaction = ubuntuPackageCapsuleRelease();
  widenedTransaction.transaction.noRemove = false;
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(widenedTransaction), /noRemove is unsupported/u);

  const missingBase = ubuntuPackageCapsuleRelease();
  missingBase.baseMediaSha256 = 'mutable-media';
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(missingBase), /base-media digest/u);

  const absentRequested = ubuntuPackageCapsuleRelease();
  absentRequested.transaction.requestedPackages.push({ name: 'git', version: '1:2.48.1-0ubuntu1' });
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(absentRequested), /git is absent/u);

  const unsafePath = ubuntuPackageCapsuleRelease();
  unsafePath.binaries.packages[0].filename = 'pool/main/../escape.deb';
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(unsafePath), /filename is invalid/u);

  const uriPath = ubuntuPackageCapsuleRelease();
  uriPath.binaries.packages[0].filename = 'https:/example.invalid/escape.deb';
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(uriPath), /filename is invalid/u);

  const encodedTraversal = ubuntuPackageCapsuleRelease();
  encodedTraversal.binaries.packages[0].filename = 'pool/main/%2e%2e/escape.deb';
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(encodedTraversal), /filename is invalid/u);

  const reusedObject = ubuntuPackageCapsuleRelease();
  reusedObject.binaries.packages[1].object = reusedObject.binaries.packages[0].object;
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(reusedObject), /reuses an immutable object/u);

  const extraObject = ubuntuPackageCapsuleRelease();
  extraObject.binaries.descriptor.objects.push({
    ...clone(extraObject.binaries.descriptor.objects[0]),
    name: 'binary-unreferenced',
    chunks: [{ ...clone(extraObject.binaries.descriptor.objects[0].chunks[0]), name: 'binary-unreferenced.chunk' }],
  });
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(extraObject), /exactly cover/u);
});

test('Ubuntu package capsule requires exact binary-to-source coverage and complete source objects', () => {
  const missingSource = ubuntuPackageCapsuleRelease();
  missingSource.sources.packages.pop();
  missingSource.sources.descriptor.objects = missingSource.sources.descriptor.objects.filter((entry) => !entry.name.startsWith('source-glibc-'));
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(missingSource), /exactly cover binary source mappings/u);

  const wrongSource = ubuntuPackageCapsuleRelease();
  wrongSource.sources.packages[0].package = 'different-source';
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(wrongSource), /exactly cover binary source mappings/u);

  const missingObject = ubuntuPackageCapsuleRelease();
  missingObject.sources.descriptor.objects.pop();
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(missingObject), /does not identify a descriptor object/u);

  const repeatedFile = ubuntuPackageCapsuleRelease();
  repeatedFile.sources.packages[1].files.push(clone(repeatedFile.sources.packages[1].files[0]));
  assert.throws(() => ubuntuPackageCapsuleReleasePayload(repeatedFile), /reuses an immutable object/u);
});

test('Ubuntu package capsule payload is canonical across inventory ordering', () => {
  const original = ubuntuPackageCapsuleRelease();
  const reordered = clone(original);
  reordered.transaction.requestedPackages.reverse();
  reordered.metadata.pockets.reverse();
  for (const pocket of reordered.metadata.pockets) pocket.components.reverse();
  reordered.metadata.descriptor.objects.reverse();
  reordered.binaries.packages.reverse();
  reordered.binaries.descriptor.objects.reverse();
  reordered.sources.packages.reverse();
  reordered.sources.descriptor.objects.reverse();
  for (const source of reordered.sources.packages) source.files.reverse();
  assert.equal(sha256(ubuntuPackageCapsuleReleasePayload(reordered)), sha256(ubuntuPackageCapsuleReleasePayload(original)));
});

test('Ubuntu package capsule authority rejects origins and remains outside setup/provider topology', async () => {
  assert.throws(() => ubuntuPackageCapsuleReleasePayload({
    ...ubuntuPackageCapsuleRelease(), origin: 'https://example.invalid/',
  }), /origin is unsupported/u);
  const source = await readFile(new URL('../src/setup/ubuntu-package-capsule-release-input.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['snapshot.ubuntu.com', 'archive.ubuntu.com', 'releases.ubuntu.com', 'raw.githubusercontent.com', 'Hyper-V', 'libvirt', 'setup --construct', 'apt-get']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(source, /(?:origin|cache|destination|localPath|url):/u);
});
