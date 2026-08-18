import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadBootstrapReleasePolicy, releaseManifestPayload, verifyRuntimeRelease } from '../src/bootstrap/release-integrity.mjs';

async function signedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-release-integrity-'));
  const candidateDir = path.join(root, 'candidate');
  await mkdir(path.join(candidateDir, 'release'), { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyFile = path.join(root, 'release-public.pem');
  await writeFile(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const manifest = {
    protocol: 'patch-poller/release-manifest-v1',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    issuedAt: '2026-08-18T12:00:00Z',
    keyId: 'operator-release-key-1',
  };
  manifest.signature = sign(null, releaseManifestPayload(manifest), privateKey).toString('base64');
  const manifestFile = path.join(candidateDir, 'release', 'patch-poller-release.json');
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const policy = {
    protocol: 'patch-poller/release-policy-v1',
    mode: 'production',
    manifestPath: 'release/patch-poller-release.json',
    keyId: manifest.keyId,
    publicKeyFile,
  };
  return { root, candidateDir, manifestFile, manifest, policy };
}

test('production candidate must match exact commit/tree and a local-policy Ed25519 signature', async () => {
  const fixture = await signedFixture();
  const result = verifyRuntimeRelease({
    candidateDir: fixture.candidateDir,
    commitSha: fixture.manifest.commit,
    treeSha: fixture.manifest.tree,
    policy: fixture.policy,
  });
  assert.equal(result.mode, 'production');
  assert.equal(result.verified, true);
  assert.equal(result.keyId, fixture.manifest.keyId);
  assert.match(result.manifestDigest, /^[0-9a-f]{64}$/u);
  assert.match(result.signedPayloadDigest, /^[0-9a-f]{64}$/u);

  assert.throws(() => verifyRuntimeRelease({
    candidateDir: fixture.candidateDir,
    commitSha: 'c'.repeat(40),
    treeSha: fixture.manifest.tree,
    policy: fixture.policy,
  }), /manifest commit does not match/u);
});

test('tampered production signature fails closed', async () => {
  const fixture = await signedFixture();
  const tampered = { ...fixture.manifest, signature: Buffer.alloc(64, 7).toString('base64') };
  await writeFile(fixture.manifestFile, `${JSON.stringify(tampered)}\n`);
  assert.throws(() => verifyRuntimeRelease({
    candidateDir: fixture.candidateDir,
    commitSha: fixture.manifest.commit,
    treeSha: fixture.manifest.tree,
    policy: fixture.policy,
  }), /signature verification failed/u);
});

test('stable channel requires local production release policy while testing may use development policy', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-release-policy-'));
  const paths = { home };
  assert.throws(() => loadBootstrapReleasePolicy({ channel: 'stable', paths, environment: {} }), /stable runtime updates require a local production release policy/u);
  const testing = loadBootstrapReleasePolicy({ channel: 'testing', paths, environment: {} });
  assert.equal(testing.mode, 'development');
  assert.equal(testing.source, 'testing-default');
});
