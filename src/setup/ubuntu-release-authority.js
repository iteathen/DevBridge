import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDetachedSignatureVerifier } from '../runtime/detached-signature-verifier.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { UBUNTU_SETUP_SOURCE_POLICY } from './ubuntu-authority.js';

const MAX_KEY_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;

async function boundedFetch(url, maxBytes, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response?.ok) throw new Error(`trusted Ubuntu authority request failed (${response?.status ?? 'unknown'}): ${url}`);
  const length = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`trusted Ubuntu authority response exceeds its size bound: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > maxBytes) throw new Error(`trusted Ubuntu authority response has an invalid size: ${url}`);
  return bytes;
}

function dearmorPublicKey(bytes) {
  const text = bytes.toString('utf8');
  const match = text.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?\r?\n\r?\n([\s\S]*?)-----END PGP PUBLIC KEY BLOCK-----/u);
  if (!match) throw new Error('Ubuntu release signing key response is not an armored public key');
  const encoded = match[1]
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('='))
    .join('');
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('Ubuntu release signing key armor is invalid');
  const keyring = Buffer.from(encoded, 'base64');
  if (keyring.length < 1 || keyring.length > MAX_KEY_BYTES) throw new Error('Ubuntu release signing key has an invalid size');
  return keyring;
}

function assertManifestMedia(manifest) {
  const wanted = UBUNTU_SETUP_SOURCE_POLICY.mediaName;
  const expected = UBUNTU_SETUP_SOURCE_POLICY.mediaSha256;
  const entries = manifest.toString('utf8').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const match = entries.find((line) => line.endsWith(` ${wanted}`) || line.endsWith(` *${wanted}`));
  if (!match) throw new Error(`Ubuntu release manifest does not contain ${wanted}`);
  const digest = match.split(/\s+/u)[0]?.toLowerCase();
  if (digest !== expected) throw new Error('Ubuntu release manifest digest does not match runtime-owned source policy');
}

async function verifyFiles({ keyring, manifest, signature, invoke }) {
  return createDetachedSignatureVerifier({ invoke, keyring }).verify({
    manifest,
    signature,
    expectedFingerprint: UBUNTU_SETUP_SOURCE_POLICY.signerFingerprint,
  });
}

export async function establishUbuntuReleaseAuthority({
  home,
  fetchImpl = globalThis.fetch,
  invoke = invokeCommand,
} = {}) {
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0') || !path.isAbsolute(home)) throw new TypeError('DevBridge home must be an absolute local path');
  if (typeof fetchImpl !== 'function') throw new TypeError('Ubuntu authority fetch implementation is invalid');
  if (typeof invoke !== 'function') throw new TypeError('Ubuntu authority invocation contract is invalid');

  const directory = path.join(path.resolve(home), 'authority', 'ubuntu-26.04');
  const keyring = path.join(directory, 'cdimage-keyring.gpg');
  const manifest = path.join(directory, 'SHA256SUMS');
  const signature = path.join(directory, 'SHA256SUMS.gpg');
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const manifestUrl = `https://releases.ubuntu.com/${UBUNTU_SETUP_SOURCE_POLICY.release}/SHA256SUMS`;
  const signatureUrl = `https://releases.ubuntu.com/${UBUNTU_SETUP_SOURCE_POLICY.release}/SHA256SUMS.gpg`;
  const [manifestBytes, signatureBytes] = await Promise.all([
    boundedFetch(manifestUrl, MAX_MANIFEST_BYTES, fetchImpl),
    boundedFetch(signatureUrl, MAX_SIGNATURE_BYTES, fetchImpl),
  ]);
  assertManifestMedia(manifestBytes);
  await writeFile(manifest, manifestBytes, { mode: 0o600 });
  await writeFile(signature, signatureBytes, { mode: 0o600 });

  let existingVerified = false;
  try {
    await readFile(keyring);
    await verifyFiles({ keyring, manifest, signature, invoke });
    existingVerified = true;
  } catch {
    existingVerified = false;
  }

  if (!existingVerified) {
    const fingerprint = UBUNTU_SETUP_SOURCE_POLICY.signerFingerprint;
    const keyUrl = `https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x${fingerprint}`;
    const armored = await boundedFetch(keyUrl, MAX_KEY_BYTES, fetchImpl);
    await writeFile(keyring, dearmorPublicKey(armored), { mode: 0o600 });
    await verifyFiles({ keyring, manifest, signature, invoke });
  }

  await rm(manifest, { force: true });
  await rm(signature, { force: true });
  return Object.freeze({
    protocol: 'devbridge/setup-ubuntu-release-authority-v1',
    keyring,
    signerFingerprint: UBUNTU_SETUP_SOURCE_POLICY.signerFingerprint,
    sourceSha256: UBUNTU_SETUP_SOURCE_POLICY.mediaSha256,
    verified: true,
  });
}
