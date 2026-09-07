import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ImmutableObjectAcquisition } from '../src/runtime/immutable-object-acquisition.js';
import { FilesystemImmutableObjectSource } from '../src/runtime/immutable-object-sources/filesystem.js';
import {
  UBUNTU_PACKAGE_CAPSULE_AVAILABILITY_PROTOCOL,
  UbuntuPackageCapsuleAvailability,
} from '../src/setup/ubuntu-package-capsule-availability.mjs';
import {
  UBUNTU_PACKAGE_CAPSULE_MANIFEST_NAME,
  UBUNTU_PACKAGE_CAPSULE_OBJECT_DIRECTORY,
  UBUNTU_PACKAGE_CAPSULE_PUBLIC_KEY_NAME,
  buildUbuntuPackageCapsuleRelease,
} from '../src/release/ubuntu-package-capsule-release-builder.mjs';
import { createUbuntuPackageCaptureFixture } from './fixtures/ubuntu-package-capsule-capture-fixture.js';

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyBytes: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    publicKeyBytes: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })),
  };
}

async function sealedRelease(root) {
  const fixture = await createUbuntuPackageCaptureFixture(path.join(root, 'capture'));
  const releaseRoot = path.join(root, 'release');
  const built = await buildUbuntuPackageCapsuleRelease({
    ...fixture,
    destination: releaseRoot,
    keyId: 'capsule-availability-test-key',
    ...keys(),
    verifyInRelease: async ({ expectedFingerprint }) => ({ verified: true, fingerprint: expectedFingerprint }),
    chunkBytes: 257,
  });
  return {
    fixture,
    releaseRoot,
    objectRoot: path.join(releaseRoot, UBUNTU_PACKAGE_CAPSULE_OBJECT_DIRECTORY),
    authority: {
      manifestBytes: await readFile(path.join(releaseRoot, UBUNTU_PACKAGE_CAPSULE_MANIFEST_NAME)),
      publicKeyBytes: await readFile(path.join(releaseRoot, UBUNTU_PACKAGE_CAPSULE_PUBLIC_KEY_NAME)),
      expectedManifestSha256: built.manifestSha256,
      expectedPublicKeySha256: built.publicKeySha256,
      expectedKeyId: built.keyId,
    },
  };
}

async function copyOrigin(source, destination) {
  await mkdir(destination);
  for (const name of await readdir(source)) await copyFile(path.join(source, name), path.join(destination, name));
}

function failingSource(observations) {
  return { async fetch(request) { observations.push(request.chunk.sha256); throw new Error('primary origin unavailable'); } };
}

test('signed capsule reacquires every exact group from a secondary origin and an offline bundle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-capsule-availability-'));
  try {
    const release = await sealedRelease(root);
    const secondary = path.join(root, 'secondary-origin');
    await copyOrigin(release.objectRoot, secondary);
    const primaryFailures = [];
    const secondaryAvailability = new UbuntuPackageCapsuleAvailability({
      authority: release.authority,
      acquisition: new ImmutableObjectAcquisition({
        directory: path.join(root, 'secondary-cache'),
        sources: [failingSource(primaryFailures), new FilesystemImmutableObjectSource({ directory: secondary })],
      }),
    });
    const fromSecondary = await secondaryAvailability.prepare();
    assert.equal(fromSecondary.protocol, UBUNTU_PACKAGE_CAPSULE_AVAILABILITY_PROTOCOL);
    assert.equal(fromSecondary.release.releaseId, release.fixture.capture.releaseId);
    assert.equal(fromSecondary.release.snapshot, release.fixture.capture.snapshot);
    assert.ok(primaryFailures.length >= 3);
    assert.deepEqual(Object.keys(fromSecondary.objects), ['metadata', 'binaries', 'sources']);
    assert.ok(fromSecondary.objects.metadata.length > 0);
    assert.ok(fromSecondary.objects.binaries.length > 0);
    assert.ok(fromSecondary.objects.sources.length > 0);

    const offlineAvailability = new UbuntuPackageCapsuleAvailability({
      authority: release.authority,
      acquisition: new ImmutableObjectAcquisition({
        directory: path.join(root, 'offline-cache'),
        sources: [new FilesystemImmutableObjectSource({ directory: release.objectRoot })],
      }),
    });
    const fromOffline = await offlineAvailability.prepare();
    assert.equal(fromOffline.release.manifestSha256, fromSecondary.release.manifestSha256);
    assert.deepEqual(
      Object.fromEntries(Object.entries(fromOffline.objects).map(([group, objects]) => [group, objects.map(({ name, size, sha256 }) => ({ name, size, sha256 }))])),
      Object.fromEntries(Object.entries(fromSecondary.objects).map(([group, objects]) => [group, objects.map(({ name, size, sha256 }) => ({ name, size, sha256 }))])),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capsule availability rejects forged acquisition evidence and preserves authority identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-capsule-availability-forged-'));
  try {
    const release = await sealedRelease(root);
    const forged = new UbuntuPackageCapsuleAvailability({
      authority: release.authority,
      acquisition: {
        async ensure({ descriptor }) {
          return {
            state: 'cache-committed',
            subject: descriptor.subject,
            descriptorSha256: 'f'.repeat(64),
            objects: [],
            sourceAttempts: 0,
            reusedChunks: 0,
          };
        },
      },
    });
    await assert.rejects(forged.prepare(), /descriptor evidence does not match authority/u);

    const changedAuthority = { ...release.authority, expectedManifestSha256: 'f'.repeat(64) };
    assert.throws(() => new UbuntuPackageCapsuleAvailability({ authority: changedAuthority, acquisition: { ensure: async () => ({}) } }), /manifest digest/u);
    await assert.rejects(new UbuntuPackageCapsuleAvailability({
      authority: release.authority,
      acquisition: { ensure: async () => ({}) },
    }).prepare({ origin: 'https://example.invalid/' }), /origin is unsupported/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capsule availability remains transport-neutral and construction-free', async () => {
  const source = await readFile(new URL('../src/setup/ubuntu-package-capsule-availability.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['snapshot.ubuntu.com', 'archive.ubuntu.com', 'github.com', 'Hyper-V', 'libvirt', 'setup --construct', 'apt-get', 'Start-VM']) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'iu'));
  }
  assert.match(source, /acquisition\.ensure/u);
  assert.match(source, /reobserveImmutableObjectAcquisition/u);
});
