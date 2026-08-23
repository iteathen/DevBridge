import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UbuntuReleaseMediaSource } from '../src/runtime/image-sources/ubuntu-release-media.js';

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-source-')); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function authority(media, overrides = {}) {
  const mediaSha = sha256(media);
  return {
    protocol: 'devbridge/ubuntu-release-media-v1',
    release: '26.04',
    architecture: 'amd64',
    media: {
      url: 'https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso',
      name: 'ubuntu-26.04-live-server-amd64.iso',
      sha256: mediaSha,
      bytes: Buffer.byteLength(media),
    },
    checksums: {
      manifestUrl: 'https://releases.ubuntu.com/26.04/SHA256SUMS',
      signatureUrl: 'https://releases.ubuntu.com/26.04/SHA256SUMS.gpg',
      signerFingerprint: '0123456789ABCDEF0123456789ABCDEF01234567',
    },
    ...overrides,
  };
}

test('Ubuntu release source binds signed manifest, exact digest, size, and official host', async () => {
  const parent = await root();
  try {
    const media = 'exact-iso-bytes';
    const approved = authority(media);
    const manifest = `${approved.media.sha256}  ${approved.media.name}\n`;
    const payloads = new Map([
      [approved.checksums.manifestUrl, manifest],
      [approved.checksums.signatureUrl, 'signature-bytes'],
      [approved.media.url, media],
    ]);
    const downloads = [];
    const source = new UbuntuReleaseMediaSource({
      authorityLookup: async (reference) => { assert.equal(reference, 'subject-0123456789abcdef0123456789abcdef'); return approved; },
      download: async ({ url, destination }) => { downloads.push(url); await writeFile(destination, payloads.get(url)); return { finalUrl: url }; },
      verifyManifest: async ({ expectedFingerprint }) => ({ verified: true, signerFingerprint: expectedFingerprint, manifestSha256: sha256(manifest) }),
    });
    const result = await source.acquire({ authorityRef: 'subject-0123456789abcdef0123456789abcdef', destination: path.join(parent, 'media') });
    assert.equal(result.identity.sha256, approved.media.sha256);
    assert.equal(result.identity.bytes, Buffer.byteLength(media));
    assert.equal(result.identity.release, '26.04');
    assert.equal(result.identity.checksumManifestSha256, sha256(manifest));
    assert.deepEqual(downloads, [approved.checksums.manifestUrl, approved.checksums.signatureUrl, approved.media.url]);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('Ubuntu release source rejects a media digest not present in the signed manifest', async () => {
  const parent = await root();
  try {
    const media = 'exact-iso-bytes';
    const approved = authority(media);
    const manifest = `${'0'.repeat(64)}  ${approved.media.name}\n`;
    const payloads = new Map([
      [approved.checksums.manifestUrl, manifest],
      [approved.checksums.signatureUrl, 'signature-bytes'],
    ]);
    let mediaDownloaded = false;
    const source = new UbuntuReleaseMediaSource({
      authorityLookup: async () => approved,
      download: async ({ url, destination }) => {
        if (url === approved.media.url) mediaDownloaded = true;
        await writeFile(destination, payloads.get(url) ?? media);
        return { finalUrl: url };
      },
      verifyManifest: async ({ expectedFingerprint }) => ({ verified: true, signerFingerprint: expectedFingerprint, manifestSha256: sha256(manifest) }),
    });
    const destination = path.join(parent, 'media');
    await assert.rejects(() => source.acquire({ authorityRef: 'subject-0123456789abcdef0123456789abcdef', destination }), /signed checksum manifest/u);
    assert.equal(mediaDownloaded, false);
    await assert.rejects(() => stat(destination), { code: 'ENOENT' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('Ubuntu release source refuses non-official URL authority before network effects', async () => {
  const parent = await root();
  try {
    const approved = authority('bytes');
    approved.media.url = 'https://example.invalid/ubuntu.iso';
    let downloads = 0;
    const source = new UbuntuReleaseMediaSource({
      authorityLookup: async () => approved,
      download: async () => { downloads += 1; },
      verifyManifest: async () => ({ verified: true, signerFingerprint: approved.checksums.signerFingerprint, manifestSha256: '0'.repeat(64) }),
    });
    await assert.rejects(() => source.acquire({ authorityRef: 'subject-0123456789abcdef0123456789abcdef', destination: path.join(parent, 'media') }), /host is not approved/u);
    assert.equal(downloads, 0);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('Ubuntu release source rejects short signer IDs and verifier/file digest disagreement', async () => {
  const parent = await root();
  try {
    const short = authority('bytes');
    short.checksums.signerFingerprint = '0123456789ABCDEF';
    let effects = 0;
    const shortSource = new UbuntuReleaseMediaSource({
      authorityLookup: async () => short,
      download: async () => { effects += 1; },
      verifyManifest: async () => { effects += 1; },
    });
    await assert.rejects(() => shortSource.acquire({ authorityRef: 'subject-0123456789abcdef0123456789abcdef', destination: path.join(parent, 'short') }), /signer identity/u);
    assert.equal(effects, 0);

    const approved = authority('bytes');
    const manifest = `${approved.media.sha256}  ${approved.media.name}\n`;
    const payloads = new Map([
      [approved.checksums.manifestUrl, manifest],
      [approved.checksums.signatureUrl, 'signature-bytes'],
    ]);
    const source = new UbuntuReleaseMediaSource({
      authorityLookup: async () => approved,
      download: async ({ url, destination }) => { await writeFile(destination, payloads.get(url)); return { finalUrl: url }; },
      verifyManifest: async ({ expectedFingerprint }) => ({ verified: true, signerFingerprint: expectedFingerprint, manifestSha256: 'f'.repeat(64) }),
    });
    const destination = path.join(parent, 'mismatch');
    await assert.rejects(() => source.acquire({ authorityRef: 'subject-0123456789abcdef0123456789abcdef', destination }), /signature verification failed/u);
    await assert.rejects(() => stat(destination), { code: 'ENOENT' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});
