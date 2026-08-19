import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASE_MANIFEST_PROTOCOL,
  RELEASE_REPOSITORY,
  readSignedReleaseManifest,
  releaseSubjectPayload,
  runtimeArtifactSha256,
  verifyRuntimeReleaseIntegrity,
} from '../src/bootstrap/release-integrity.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-release-integrity-'));
  const runtimeDir = path.join(root, 'runtime');
  await mkdir(path.join(runtimeDir, 'src'), { recursive: true });
  await writeFile(path.join(runtimeDir, 'package.json'), '{"name":"patch-poller","version":"0.1.0"}\n');
  await writeFile(path.join(runtimeDir, 'src', 'cli.js'), 'console.log("release fixture");\n');
  const artifact = await runtimeArtifactSha256(runtimeDir);
  const head = 'a'.repeat(40);
  const release = {
    repository: RELEASE_REPOSITORY,
    head,
    artifactSha256: artifact.sha256,
    version: '0.1.0',
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, releaseSubjectPayload(release), privateKey).toString('base64');
  const manifestPath = path.join(root, 'release.json');
  const publicKeyPath = path.join(root, 'release.pub.pem');
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(manifestPath, `${JSON.stringify({
    protocol: RELEASE_MANIFEST_PROTOCOL,
    release,
    signature: { algorithm: 'ed25519', keyId: 'test-release-key', value: signature },
  }, null, 2)}\n`);
  return { root, runtimeDir, artifact, head, manifestPath, publicKeyPath, release, privateKey };
}

test('production release manifest verifies signature, exact head, version, and runtime SHA-256', async () => {
  const f = await fixture();
  const manifest = await readSignedReleaseManifest(f.manifestPath, f.publicKeyPath);
  assert.equal(manifest.release.head, f.head);
  assert.equal(manifest.release.artifactSha256, f.artifact.sha256);
  assert.equal(manifest.signature.keyId, 'test-release-key');
  const integrity = await verifyRuntimeReleaseIntegrity({
    args: {
      releaseMode: 'production',
      releaseManifest: f.manifestPath,
      releasePublicKey: f.publicKeyPath,
    },
    runtime: { runtimeDir: f.runtimeDir, head: f.head, version: '0.1.0' },
    manifest,
  });
  assert.equal(integrity.verified, true);
  assert.equal(integrity.immutableRelease, true);
  assert.equal(integrity.artifactSha256, f.artifact.sha256);
  assert.equal(integrity.releaseHead, f.head);
});

test('production integrity fails closed for modified bytes, head/version mismatch, or signature tampering', async () => {
  const f = await fixture();
  const manifest = await readSignedReleaseManifest(f.manifestPath, f.publicKeyPath);
  await writeFile(path.join(f.runtimeDir, 'src', 'cli.js'), 'console.log("tampered");\n');
  await assert.rejects(() => verifyRuntimeReleaseIntegrity({
    args: { releaseMode: 'production' },
    runtime: { runtimeDir: f.runtimeDir, head: f.head, version: '0.1.0' },
    manifest,
  }), /does not match signed release artifact/u);

  const clean = await fixture();
  const cleanManifest = await readSignedReleaseManifest(clean.manifestPath, clean.publicKeyPath);
  await assert.rejects(() => verifyRuntimeReleaseIntegrity({
    args: { releaseMode: 'production' },
    runtime: { runtimeDir: clean.runtimeDir, head: 'b'.repeat(40), version: '0.1.0' },
    manifest: cleanManifest,
  }), /does not match signed release head/u);
  await assert.rejects(() => verifyRuntimeReleaseIntegrity({
    args: { releaseMode: 'production' },
    runtime: { runtimeDir: clean.runtimeDir, head: clean.head, version: '9.9.9' },
    manifest: cleanManifest,
  }), /does not match signed release version/u);

  const badManifestPath = path.join(clean.root, 'bad-release.json');
  const badRelease = { ...clean.release, head: 'c'.repeat(40) };
  const staleSignature = sign(null, releaseSubjectPayload(clean.release), clean.privateKey).toString('base64');
  await writeFile(badManifestPath, `${JSON.stringify({
    protocol: RELEASE_MANIFEST_PROTOCOL,
    release: badRelease,
    signature: { algorithm: 'ed25519', keyId: 'test-release-key', value: staleSignature },
  })}\n`);
  await assert.rejects(
    () => readSignedReleaseManifest(badManifestPath, clean.publicKeyPath),
    /signature verification failed/u,
  );
});

test('development integrity is explicitly unsigned and still records the exact artifact digest', async () => {
  const f = await fixture();
  const integrity = await verifyRuntimeReleaseIntegrity({
    args: { releaseMode: 'development' },
    runtime: { runtimeDir: f.runtimeDir, head: f.head, version: '0.1.0' },
  });
  assert.equal(integrity.mode, 'development');
  assert.equal(integrity.verified, false);
  assert.equal(integrity.immutableRelease, false);
  assert.equal(integrity.artifactSha256, f.artifact.sha256);
});
