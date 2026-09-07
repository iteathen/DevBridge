import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { link, lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ImmutableObjectAcquisition } from '../src/runtime/immutable-object-acquisition.js';
import { FilesystemImmutableObjectSource } from '../src/runtime/immutable-object-sources/filesystem.js';
import { verifyUbuntuPackageCapsuleReleaseInput } from '../src/setup/ubuntu-package-capsule-release-input.mjs';
import { GpgvInReleaseVerifier } from '../src/release/gpgv-inrelease-verifier.mjs';
import {
  UBUNTU_PACKAGE_CAPSULE_MANIFEST_NAME,
  UBUNTU_PACKAGE_CAPSULE_OBJECT_DIRECTORY,
  UBUNTU_PACKAGE_CAPSULE_PUBLIC_KEY_NAME,
  buildUbuntuPackageCapsuleRelease,
} from '../src/release/ubuntu-package-capsule-release-builder.mjs';
import { createUbuntuPackageCaptureFixture } from './fixtures/ubuntu-package-capsule-capture-fixture.js';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function keyFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return Object.freeze({
    privateKeyBytes: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    publicKeyBytes: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })),
  });
}

function signatureVerifier(fingerprint, observations = []) {
  return async ({ bytes, expectedFingerprint, context }) => {
    assert.equal(expectedFingerprint, fingerprint);
    assert.match(bytes.toString('utf8'), /^-----BEGIN PGP SIGNED MESSAGE-----/u);
    observations.push(context);
    return { verified: true, fingerprint };
  };
}

async function makeDscInternallyInconsistent(fixture) {
  const source = fixture.capture.sources.packages[0];
  const dscArtifact = fixture.artifacts.source.find((entry) => entry.name === source.dsc.object);
  const previousDsc = await readFile(dscArtifact.location);
  const wrongDsc = Buffer.from([
    `Source: ${source.package}`,
    `Version: ${source.version}`,
    'Checksums-Sha256:',
    ` ${'0'.repeat(64)} 1 ${source.files[0].filename}`,
    '',
  ].join('\n'), 'utf8');
  await writeFile(dscArtifact.location, wrongDsc);
  for (const pocket of fixture.capture.metadata.pockets) {
    for (const component of pocket.components) {
      const indexArtifact = fixture.artifacts.metadata.find((entry) => entry.name === component.sourceIndex.object);
      const previousIndex = await readFile(indexArtifact.location);
      const changedText = gunzipSync(previousIndex).toString('utf8').replace(
        `${sha256(previousDsc)} ${previousDsc.length} ${source.dsc.filename}`,
        `${sha256(wrongDsc)} ${wrongDsc.length} ${source.dsc.filename}`,
      );
      const changedIndex = gzipSync(Buffer.from(changedText, 'utf8'), { level: 9, mtime: 0 });
      await writeFile(indexArtifact.location, changedIndex);
      const inReleaseArtifact = fixture.artifacts.metadata.find((entry) => entry.name === pocket.inRelease.object);
      const changedInRelease = (await readFile(inReleaseArtifact.location, 'utf8')).replace(
        `${sha256(previousIndex)} ${previousIndex.length} ${component.sourceIndex.path}`,
        `${sha256(changedIndex)} ${changedIndex.length} ${component.sourceIndex.path}`,
      );
      await writeFile(inReleaseArtifact.location, changedInRelease);
    }
  }
}

async function authority(root, built) {
  const manifestBytes = await readFile(path.join(root, UBUNTU_PACKAGE_CAPSULE_MANIFEST_NAME));
  const publicKeyBytes = await readFile(path.join(root, UBUNTU_PACKAGE_CAPSULE_PUBLIC_KEY_NAME));
  return {
    manifestBytes,
    publicKeyBytes,
    expectedManifestSha256: built.manifestSha256,
    expectedPublicKeySha256: built.publicKeySha256,
    expectedKeyId: built.keyId,
  };
}

test('capsule sealer verifies the upstream chain and publishes an offline-acquirable signed release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-ubuntu-capsule-release-'));
  try {
    const fixture = await createUbuntuPackageCaptureFixture(path.join(root, 'capture'));
    const keys = keyFixture();
    const output = path.join(root, 'release');
    const observations = [];
    const built = await buildUbuntuPackageCapsuleRelease({
      ...fixture,
      destination: output,
      keyId: 'ubuntu-capsule-release-key',
      ...keys,
      verifyInRelease: signatureVerifier(fixture.capture.upstreamKeyFingerprint, observations),
      chunkBytes: 1024,
    });
    assert.deepEqual(observations.sort(), ['resolute', 'resolute-security', 'resolute-updates']);
    assert.equal(built.metadataObjects, 15);
    assert.equal(built.binaryObjects, 3);
    assert.equal(built.sourceObjects, 8);
    assert.deepEqual((await readdir(output)).sort(), [
      UBUNTU_PACKAGE_CAPSULE_MANIFEST_NAME,
      UBUNTU_PACKAGE_CAPSULE_OBJECT_DIRECTORY,
      UBUNTU_PACKAGE_CAPSULE_PUBLIC_KEY_NAME,
    ].sort());
    assert.deepEqual((await readdir(path.join(output, UBUNTU_PACKAGE_CAPSULE_OBJECT_DIRECTORY))).sort(), [...built.objectDigests].sort());

    const accepted = verifyUbuntuPackageCapsuleReleaseInput(await authority(output, built));
    assert.equal([
      ...accepted.metadata.descriptor.objects,
      ...accepted.binaries.descriptor.objects,
      ...accepted.sources.descriptor.objects,
    ].some((object) => object.chunks.length > 1), true);
    assert.equal(accepted.snapshot, fixture.capture.snapshot);
    assert.equal(accepted.upstreamKeyFingerprint, fixture.capture.upstreamKeyFingerprint);
    const acquisition = new ImmutableObjectAcquisition({
      directory: path.join(root, 'cache'),
      sources: [new FilesystemImmutableObjectSource({ directory: path.join(output, UBUNTU_PACKAGE_CAPSULE_OBJECT_DIRECTORY) })],
    });
    for (const descriptor of [accepted.metadata.descriptor, accepted.binaries.descriptor, accepted.sources.descriptor]) {
      const acquired = await acquisition.ensure({ descriptor });
      assert.equal(acquired.objects.length, descriptor.objects.length);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capsule sealer output is canonical across capture and artifact ordering', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-ubuntu-capsule-order-'));
  try {
    const fixture = await createUbuntuPackageCaptureFixture(path.join(root, 'capture'));
    const keys = keyFixture();
    const first = await buildUbuntuPackageCapsuleRelease({
      ...fixture,
      destination: path.join(root, 'first'),
      keyId: 'ubuntu-capsule-release-key',
      ...keys,
      verifyInRelease: signatureVerifier(fixture.capture.upstreamKeyFingerprint),
      chunkBytes: 4096,
    });
    const capture = structuredClone(fixture.capture);
    capture.transaction.requestedPackages.reverse();
    capture.metadata.pockets.reverse();
    for (const pocket of capture.metadata.pockets) pocket.components.reverse();
    capture.binaries.packages.reverse();
    capture.sources.packages.reverse();
    for (const source of capture.sources.packages) source.files.reverse();
    const artifacts = structuredClone(fixture.artifacts);
    for (const entries of Object.values(artifacts)) entries.reverse();
    const second = await buildUbuntuPackageCapsuleRelease({
      capture,
      artifacts,
      destination: path.join(root, 'second'),
      keyId: 'ubuntu-capsule-release-key',
      ...keys,
      verifyInRelease: signatureVerifier(fixture.capture.upstreamKeyFingerprint),
      chunkBytes: 4096,
    });
    assert.equal(second.manifestSha256, first.manifestSha256);
    assert.deepEqual(second.objectDigests, first.objectDigests);
    assert.deepEqual(
      await readFile(path.join(root, 'second', UBUNTU_PACKAGE_CAPSULE_MANIFEST_NAME)),
      await readFile(path.join(root, 'first', UBUNTU_PACKAGE_CAPSULE_MANIFEST_NAME)),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capsule sealer rejects signature, index, binary, and source drift without release residue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-ubuntu-capsule-failure-'));
  try {
    const keys = keyFixture();
    const badSignature = await createUbuntuPackageCaptureFixture(path.join(root, 'signature-capture'));
    await assert.rejects(buildUbuntuPackageCapsuleRelease({
      ...badSignature,
      destination: path.join(root, 'signature-output'),
      keyId: 'key',
      ...keys,
      verifyInRelease: async () => ({ verified: true, fingerprint: 'F'.repeat(40) }),
      chunkBytes: 4096,
    }), /signature evidence/u);

    const badIndex = await createUbuntuPackageCaptureFixture(path.join(root, 'index-capture'));
    await writeFile(badIndex.artifacts.metadata.find((entry) => entry.name.endsWith('binary-index')).location, 'changed-index');
    await assert.rejects(buildUbuntuPackageCapsuleRelease({
      ...badIndex,
      destination: path.join(root, 'index-output'),
      keyId: 'key',
      ...keys,
      verifyInRelease: signatureVerifier(badIndex.capture.upstreamKeyFingerprint),
      chunkBytes: 4096,
    }), /index does not match|index bytes/u);

    const wrongPocket = await createUbuntuPackageCaptureFixture(path.join(root, 'pocket-capture'));
    const inRelease = wrongPocket.artifacts.metadata.find((entry) => entry.name === 'resolute-inrelease');
    const changedPocket = (await readFile(inRelease.location, 'utf8')).replace('Suite: resolute\n', 'Suite: resolute-updates\n');
    await writeFile(inRelease.location, changedPocket);
    await assert.rejects(buildUbuntuPackageCapsuleRelease({
      ...wrongPocket,
      destination: path.join(root, 'pocket-output'),
      keyId: 'key',
      ...keys,
      verifyInRelease: signatureVerifier(wrongPocket.capture.upstreamKeyFingerprint),
      chunkBytes: 4096,
    }), /release identity does not match/u);

    const badBinary = await createUbuntuPackageCaptureFixture(path.join(root, 'binary-capture'));
    await writeFile(badBinary.artifacts.binary[0].location, 'changed-deb');
    await assert.rejects(buildUbuntuPackageCapsuleRelease({
      ...badBinary,
      destination: path.join(root, 'binary-output'),
      keyId: 'key',
      ...keys,
      verifyInRelease: signatureVerifier(badBinary.capture.upstreamKeyFingerprint),
      chunkBytes: 4096,
    }), /binary build-essential does not match/u);

    const badSource = await createUbuntuPackageCaptureFixture(path.join(root, 'source-capture'));
    await makeDscInternallyInconsistent(badSource);
    await assert.rejects(buildUbuntuPackageCapsuleRelease({
      ...badSource,
      destination: path.join(root, 'source-output'),
      keyId: 'key',
      ...keys,
      verifyInRelease: signatureVerifier(badSource.capture.upstreamKeyFingerprint),
      chunkBytes: 4096,
    }), /source build-essential dsc file .* does not match its upstream/u);

    for (const name of ['signature-output', 'index-output', 'pocket-output', 'binary-output', 'source-output']) {
      await assert.rejects(lstat(path.join(root, name)), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capsule sealer preserves caller-owned output and rejects duplicate filesystem inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-ubuntu-capsule-boundary-'));
  try {
    const fixture = await createUbuntuPackageCaptureFixture(path.join(root, 'capture'));
    const keys = keyFixture();
    await assert.rejects(buildUbuntuPackageCapsuleRelease({
      ...fixture,
      destination: path.join(root, 'unknown-output'),
      keyId: 'key',
      ...keys,
      verifyInRelease: signatureVerifier(fixture.capture.upstreamKeyFingerprint),
      origin: 'https://example.invalid/',
    }), /request\.origin is unsupported/u);
    await assert.rejects(buildUbuntuPackageCapsuleRelease({
      ...fixture,
      destination: path.join(root, 'oversized-chunk-output'),
      keyId: 'key',
      ...keys,
      verifyInRelease: signatureVerifier(fixture.capture.upstreamKeyFingerprint),
      chunkBytes: (64 * 1024 * 1024) + 1,
    }), /chunk size is invalid/u);
    await assert.rejects(lstat(path.join(root, 'oversized-chunk-output')), { code: 'ENOENT' });
    const existing = path.join(root, 'existing');
    await mkdir(existing);
    await writeFile(path.join(existing, 'sentinel'), 'keep');
    await assert.rejects(buildUbuntuPackageCapsuleRelease({
      ...fixture,
      destination: existing,
      keyId: 'key',
      ...keys,
      verifyInRelease: signatureVerifier(fixture.capture.upstreamKeyFingerprint),
    }), /destination already exists/u);
    assert.equal(await readFile(path.join(existing, 'sentinel'), 'utf8'), 'keep');

    const duplicate = structuredClone(fixture.artifacts);
    const linked = path.join(root, 'linked-input');
    await link(duplicate.binary[0].location, linked);
    duplicate.binary[1].location = linked;
    await assert.rejects(buildUbuntuPackageCapsuleRelease({
      capture: fixture.capture,
      artifacts: duplicate,
      destination: path.join(root, 'duplicate-output'),
      keyId: 'key',
      ...keys,
      verifyInRelease: signatureVerifier(fixture.capture.upstreamKeyFingerprint),
    }), /unlinked regular file|distinct/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('gpgv adapter pins one exact valid signature and re-observes executable and keyring', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-gpgv-release-'));
  try {
    const executable = path.join(root, 'gpgv');
    const keyring = path.join(root, 'ubuntu.gpg');
    await writeFile(executable, 'fixture-executable');
    await writeFile(keyring, 'fixture-keyring');
    const fingerprint = '843938DF228D22F7B3742BC0D94AA3F0EFE21092';
    const verifier = new GpgvInReleaseVerifier({
      executable,
      keyring,
      run: async (program, selectedKeyring, bytes) => {
        assert.equal(program, executable);
        assert.equal(selectedKeyring, keyring);
        assert.equal(bytes.toString('utf8'), 'signed');
        return { code: 0, signal: null, stdout: `[GNUPG:] VALIDSIG ${fingerprint} 0 0 0 0 0 0 0 0 0\n`, stderr: '' };
      },
    });
    assert.deepEqual(await verifier.verify({ bytes: Buffer.from('signed'), expectedFingerprint: fingerprint }), {
      verified: true,
      fingerprint,
    });
    await assert.rejects(verifier.verify({
      bytes: Buffer.from('signed'), expectedFingerprint: fingerprint, origin: 'https://example.invalid/',
    }), /request\.origin is unsupported/u);
    await assert.rejects(verifier.verify({ bytes: Buffer.from('signed'), expectedFingerprint: 'F'.repeat(40) }), /expected fingerprint/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Ubuntu capsule release CLI rejects ambiguous authority before reading inputs', async () => {
  const script = path.resolve('scripts/build-ubuntu-package-capsule-release.mjs');
  const unknown = spawnSync(process.execPath, [script, '--origin', 'https://example.invalid/'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /option --origin is unsupported/u);
  const duplicate = spawnSync(process.execPath, [script, '--recipe', 'x', '--recipe', 'y'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /option --recipe is duplicated/u);
});

test('Ubuntu capsule release modules retain release-only LEGO ownership', async () => {
  const sources = await Promise.all([
    readFile(new URL('../src/release/immutable-object-file-publisher.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/release/ubuntu-package-capsule-capture-verifier.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/release/ubuntu-package-capsule-release-builder.mjs', import.meta.url), 'utf8'),
  ]);
  for (const source of sources) {
    for (const forbidden of ['snapshot.ubuntu.com', 'archive.ubuntu.com', 'raw.githubusercontent.com', 'Hyper-V', 'libvirt', 'setup --construct', 'apt-get', 'prepareRuntimeCandidate']) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  }
});
