import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UbuntuPackageRepository } from '../src/setup/ubuntu-package-repository.mjs';
import { ubuntuPackageCapsuleReleasePayload } from '../src/setup/ubuntu-package-capsule-release-input.mjs';
import { buildUbuntuPackageCapsuleRelease } from '../src/release/ubuntu-package-capsule-release-builder.mjs';
import { ImmutableObjectAcquisition } from '../src/runtime/immutable-object-acquisition.js';
import { FilesystemImmutableObjectSource } from '../src/runtime/immutable-object-sources/filesystem.js';
import { createUbuntuPackageCaptureFixture } from './fixtures/ubuntu-package-capsule-capture-fixture.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(root) {
  const captured = await createUbuntuPackageCaptureFixture(path.join(root, 'capture'));
  const keys = generateKeyPairSync('ed25519');
  const destination = path.join(root, 'release');
  const built = await buildUbuntuPackageCapsuleRelease({
    ...captured, destination, keyId: 'repository-test', chunkBytes: 257,
    privateKeyBytes: Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })),
    publicKeyBytes: Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })),
    verifyInRelease: async ({ expectedFingerprint }) => ({ verified: true, fingerprint: expectedFingerprint }),
  });
  const authority = {
    manifestBytes: await readFile(path.join(destination, 'ubuntu-package-capsule-manifest.json')),
    publicKeyBytes: await readFile(path.join(destination, 'ubuntu-package-capsule-public-key.pem')),
    expectedManifestSha256: built.manifestSha256, expectedPublicKeySha256: built.publicKeySha256,
    expectedKeyId: built.keyId,
  };
  return { authority, keys, destination };
}
function changedAuthority(original, keys, change) {
  const manifest = JSON.parse(original.manifestBytes);
  change(manifest.release);
  manifest.signature.value = sign(null, ubuntuPackageCapsuleReleasePayload(manifest.release), keys.privateKey).toString('base64');
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { ...original, manifestBytes, expectedManifestSha256: hash(manifestBytes) };
}

test('repository projects exact signed metadata, binaries and sources from the existing offline acquisition', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-repository-'));
  try {
    const input = await fixture(root);
    const repository = new UbuntuPackageRepository({ authority: input.authority, acquisition: new ImmutableObjectAcquisition({
      directory: path.join(root, 'cache'), sources: [new FilesystemImmutableObjectSource({ directory: path.join(input.destination, 'objects') })],
    }) });
    const result = await repository.prepare();
    const manifest = JSON.parse(input.authority.manifestBytes).release;
    assert.equal(result.release.manifestSha256, input.authority.expectedManifestSha256);
    assert.deepEqual(result.release.transaction.requestedPackages, manifest.transaction.requestedPackages);
    const expected = new Map();
    const descriptorObjects = new Map(['metadata', 'binaries', 'sources'].flatMap((group) => manifest[group].descriptor.objects.map((object) => [object.name, object])));
    for (const pocket of manifest.metadata.pockets) {
      expected.set(pocket.inRelease.path, pocket.inRelease.object);
      for (const component of pocket.components) for (const index of [component.binaryIndex, component.sourceIndex]) expected.set(`dists/${pocket.pocket}/${index.path}`, index.object);
    }
    for (const binary of manifest.binaries.packages) expected.set(binary.filename, binary.object);
    for (const source of manifest.sources.packages) for (const file of [source.dsc, ...source.files]) expected.set(`${source.directory}/${file.filename}`, file.object);
    assert.equal(result.files.length, expected.size);
    for (const file of result.files) {
      assert.ok(expected.has(file.path));
      const exact = descriptorObjects.get(expected.get(file.path));
      assert.equal(file.source.size, exact.size);
      assert.equal(file.source.sha256, exact.sha256);
      const bytes = await readFile(file.source.location);
      assert.equal(bytes.length, file.source.size);
      assert.equal(hash(bytes), file.source.sha256);
    }
    assert.deepEqual(await repository.prepare(), result, 'exact cached re-entry is stable');
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.files));
    for (const file of result.files) assert.ok(Object.isFrozen(file) && Object.isFrozen(file.source));
    await assert.rejects(repository.prepare({ mirror: 'untrusted' }), /unsupported/);
    const abort = new AbortController(); abort.abort(new Error('cancel repository'));
    await assert.rejects(repository.prepare({ signal: abort.signal }), /cancel repository/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('signed conflicting repository paths fail before acquisition; invalid bytes confer no layout authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-repository-conflicts-'));
  try {
    const input = await fixture(root);
    let acquired = 0;
    const acquisition = { ensure() { acquired += 1; throw new Error('must not acquire'); } };
    for (const change of [
      (release) => { release.binaries.packages[1].filename = release.binaries.packages[0].filename; },
      (release) => { release.sources.packages[0].directory = release.binaries.packages[0].filename; },
    ]) assert.throws(() => new UbuntuPackageRepository({ authority: changedAuthority(input.authority, input.keys, change), acquisition }), /collision/);
    assert.equal(acquired, 0);
    assert.throws(() => new UbuntuPackageRepository({ authority: { ...input.authority, expectedManifestSha256: 'f'.repeat(64) }, acquisition }), /digest/);
    assert.throws(() => new UbuntuPackageRepository({ authority: input.authority, acquisition, destination: 'arbitrary' }), /unsupported/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
