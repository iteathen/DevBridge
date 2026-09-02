import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { IMMUTABLE_OBJECT_SET_PROTOCOL } from '../runtime/immutable-object-set.js';
import {
  UBUNTU_PACKAGE_CAPSULE_MANIFEST_PROTOCOL,
  ubuntuPackageCapsuleReleasePayload,
  verifyUbuntuPackageCapsuleReleaseInput,
} from '../setup/ubuntu-package-capsule-release-input.mjs';
import {
  DEFAULT_IMMUTABLE_OBJECT_CHUNK_BYTES,
  publishImmutableObjectFiles,
} from './immutable-object-file-publisher.mjs';
import { verifyUbuntuPackageCapsuleCapture } from './ubuntu-package-capsule-capture-verifier.mjs';

export const UBUNTU_PACKAGE_CAPSULE_MANIFEST_NAME = 'ubuntu-package-capsule-manifest.json';
export const UBUNTU_PACKAGE_CAPSULE_PUBLIC_KEY_NAME = 'ubuntu-package-capsule-public-key.pem';
export const UBUNTU_PACKAGE_CAPSULE_OBJECT_DIRECTORY = 'objects';

const MAX_KEY_BYTES = 16 * 1024;
const KEY_ID = /^[A-Za-z0-9_.:-]+$/u;
const GROUPS = Object.freeze(['metadata', 'binary', 'source']);
const GROUP_MAXIMUMS = Object.freeze({ metadata: 64, binary: 8192, source: 8192 });

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function boundedBytes(value, name) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_KEY_BYTES) {
    throw new TypeError(`${name} bytes are invalid`);
  }
  return Buffer.from(value);
}

function signingKeys(privateKeyBytes, publicKeyBytes) {
  let privateKey;
  let publicKey;
  try { privateKey = createPrivateKey(boundedBytes(privateKeyBytes, 'Ubuntu capsule private key')); }
  catch { fail('Ubuntu capsule private key could not be parsed'); }
  try { publicKey = createPublicKey(boundedBytes(publicKeyBytes, 'Ubuntu capsule public key')); }
  catch { fail('Ubuntu capsule public key could not be parsed'); }
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    fail('Ubuntu capsule release signing keys must be Ed25519');
  }
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const supplied = publicKey.export({ type: 'spki', format: 'der' });
  if (!derived.equals(supplied)) fail('Ubuntu capsule release signing keys do not match');
  return Object.freeze({ privateKey, publicKeyBytes: Buffer.from(publicKeyBytes) });
}

async function writeAll(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (bytesWritten < 1) fail('Ubuntu capsule release output write did not advance');
    offset += bytesWritten;
  }
}

async function writeExactFile(location, bytes) {
  const handle = await open(location, 'wx', 0o600);
  try { await writeAll(handle, bytes, 0); await handle.sync(); }
  finally { await handle.close(); }
}

function captureShape(raw) {
  const capture = exactObject(raw, new Set([
    'distribution', 'release', 'codename', 'architecture', 'snapshot', 'baseMediaSha256',
    'releaseId', 'sequence', 'upstreamKeyFingerprint', 'transaction', 'metadata', 'binaries', 'sources',
  ]), 'Ubuntu capsule capture');
  const metadata = exactObject(capture.metadata, new Set(['pockets']), 'Ubuntu capsule capture metadata');
  const binaries = exactObject(capture.binaries, new Set(['packages']), 'Ubuntu capsule capture binaries');
  const sources = exactObject(capture.sources, new Set(['packages']), 'Ubuntu capsule capture sources');
  return Object.freeze({ capture, metadata, binaries, sources });
}

function artifactInputs(raw) {
  const artifacts = exactObject(raw, new Set(GROUPS), 'Ubuntu capsule artifacts');
  const names = new Set();
  const groups = new Map();
  for (const group of GROUPS) {
    const selected = artifacts[group];
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > GROUP_MAXIMUMS[group]) {
      throw new TypeError(`Ubuntu capsule ${group} artifacts are invalid`);
    }
    const entries = selected.map((entry, index) => {
      const value = exactObject(entry, new Set(['name', 'location']), `Ubuntu capsule ${group} artifact ${index}`);
      if (typeof value.name !== 'string' || names.has(value.name)) throw new TypeError('Ubuntu capsule artifact names must be globally unique');
      names.add(value.name);
      return Object.freeze({ name: value.name, location: value.location, group });
    });
    groups.set(group, Object.freeze(entries));
  }
  return Object.freeze({ groups, all: Object.freeze(GROUPS.flatMap((group) => groups.get(group))) });
}

function descriptorFor(releaseId, group, objects, entries) {
  const selected = new Set(entries.map((entry) => entry.name));
  return Object.freeze({
    protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
    subject: `ubuntu-capsule-${releaseId}-${group}`,
    objects: Object.freeze(objects.filter((object) => selected.has(object.name))),
  });
}

function canonicalRelease(verified) {
  return Object.freeze({
    distribution: verified.distribution,
    release: verified.release,
    codename: verified.codename,
    architecture: verified.architecture,
    snapshot: verified.snapshot,
    baseMediaSha256: verified.baseMediaSha256,
    releaseId: verified.releaseId,
    sequence: verified.sequence,
    upstreamKeyFingerprint: verified.upstreamKeyFingerprint,
    transaction: verified.transaction,
    metadata: Object.freeze({ descriptor: verified.metadata.descriptor, pockets: verified.metadata.pockets }),
    binaries: Object.freeze({ descriptor: verified.binaries.descriptor, packages: verified.binaries.packages }),
    sources: Object.freeze({ descriptor: verified.sources.descriptor, packages: verified.sources.packages }),
  });
}

async function objectReader(objectRoot, descriptors, group, name, maximum) {
  const descriptor = descriptors.get(group);
  const object = descriptor?.objects.find((entry) => entry.name === name);
  if (!object) fail(`Ubuntu capsule ${group} object ${name} is absent`);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || object.size > maximum) {
    fail(`Ubuntu capsule ${group} object ${name} exceeds its read bound`);
  }
  const buffers = [];
  let size = 0;
  for (const chunk of object.chunks) {
    const location = path.join(objectRoot, chunk.sha256);
    const info = await lstat(location, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size !== BigInt(chunk.size)) {
      fail(`Ubuntu capsule object chunk ${chunk.sha256} is invalid`);
    }
    const bytes = await readFile(location);
    if (bytes.length !== chunk.size || sha256(bytes) !== chunk.sha256) fail(`Ubuntu capsule object chunk ${chunk.sha256} changed`);
    buffers.push(bytes);
    size += bytes.length;
  }
  if (size !== object.size) fail(`Ubuntu capsule object ${name} has invalid chunk coverage`);
  const bytes = Buffer.concat(buffers, size);
  if (sha256(bytes) !== object.sha256) fail(`Ubuntu capsule object ${name} has invalid whole-object identity`);
  return bytes;
}

function authorityFor(release, signature, keyId, publicKeyBytes) {
  const manifestBytes = Buffer.from(JSON.stringify({
    protocol: UBUNTU_PACKAGE_CAPSULE_MANIFEST_PROTOCOL,
    release,
    signature: { algorithm: 'ed25519', keyId, value: signature },
  }), 'utf8');
  return Object.freeze({
    manifestBytes,
    publicKeyBytes,
    expectedManifestSha256: sha256(manifestBytes),
    expectedPublicKeySha256: sha256(publicKeyBytes),
    expectedKeyId: keyId,
  });
}

export async function buildUbuntuPackageCapsuleRelease(raw = {}) {
  const {
    capture,
    artifacts,
    destination,
    keyId,
    privateKeyBytes,
    publicKeyBytes,
    verifyInRelease,
    decodeIndex,
    chunkBytes = DEFAULT_IMMUTABLE_OBJECT_CHUNK_BYTES,
    signal = null,
  } = exactObject(raw, new Set([
    'capture', 'artifacts', 'destination', 'keyId', 'privateKeyBytes', 'publicKeyBytes',
    'verifyInRelease', 'decodeIndex', 'chunkBytes', 'signal',
  ]), 'Ubuntu capsule release request');
  const shaped = captureShape(capture);
  const inputs = artifactInputs(artifacts);
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) {
    throw new TypeError('Ubuntu capsule release output directory is invalid');
  }
  if (typeof keyId !== 'string' || keyId.length > 128 || !KEY_ID.test(keyId)) {
    throw new TypeError('Ubuntu capsule release key identity is invalid');
  }
  if (typeof verifyInRelease !== 'function') throw new TypeError('Ubuntu capsule InRelease-verifier port is invalid');
  if (decodeIndex != null && typeof decodeIndex !== 'function') throw new TypeError('Ubuntu capsule index-decoder port is invalid');
  if (signal != null && typeof signal !== 'object') throw new TypeError('Ubuntu capsule release signal is invalid');
  if (signal?.aborted) throw signal.reason ?? new Error('Ubuntu capsule release was interrupted');
  const keys = signingKeys(privateKeyBytes, publicKeyBytes);
  const root = path.resolve(destination);
  try { await mkdir(root, { recursive: false, mode: 0o700 }); }
  catch (error) { if (error?.code === 'EEXIST') fail('Ubuntu capsule release destination already exists'); throw error; }
  try {
    const objectRoot = path.join(root, UBUNTU_PACKAGE_CAPSULE_OBJECT_DIRECTORY);
    const published = await publishImmutableObjectFiles({
      destination: objectRoot,
      subject: `ubuntu-capsule-${shaped.capture.releaseId}-all`,
      inputs: inputs.all.map(({ name, location }) => ({ name, location })),
      chunkBytes,
      signal,
    });
    const descriptors = new Map(GROUPS.map((group) => [
      group,
      descriptorFor(shaped.capture.releaseId, group, published.descriptor.objects, inputs.groups.get(group)),
    ]));
    const release = Object.freeze({
      distribution: shaped.capture.distribution,
      release: shaped.capture.release,
      codename: shaped.capture.codename,
      architecture: shaped.capture.architecture,
      snapshot: shaped.capture.snapshot,
      baseMediaSha256: shaped.capture.baseMediaSha256,
      releaseId: shaped.capture.releaseId,
      sequence: shaped.capture.sequence,
      upstreamKeyFingerprint: shaped.capture.upstreamKeyFingerprint,
      transaction: shaped.capture.transaction,
      metadata: Object.freeze({ descriptor: descriptors.get('metadata'), pockets: shaped.metadata.pockets }),
      binaries: Object.freeze({ descriptor: descriptors.get('binary'), packages: shaped.binaries.packages }),
      sources: Object.freeze({ descriptor: descriptors.get('source'), packages: shaped.sources.packages }),
    });
    ubuntuPackageCapsuleReleasePayload(release);
    const captureEvidence = await verifyUbuntuPackageCapsuleCapture({
      release,
      readObject: (group, name, maximum) => objectReader(objectRoot, descriptors, group, name, maximum),
      verifyInRelease: (request) => verifyInRelease({ ...request, signal }),
      ...(decodeIndex == null ? {} : { decodeIndex }),
    });
    if (captureEvidence?.verified !== true || captureEvidence.upstreamKeyFingerprint !== release.upstreamKeyFingerprint) {
      fail('Ubuntu capsule capture verifier returned invalid evidence');
    }

    const provisionalSignature = sign(null, ubuntuPackageCapsuleReleasePayload(release), keys.privateKey).toString('base64');
    const provisional = authorityFor(release, provisionalSignature, keyId, keys.publicKeyBytes);
    const normalized = verifyUbuntuPackageCapsuleReleaseInput(provisional);
    const canonical = canonicalRelease(normalized);
    const signature = sign(null, ubuntuPackageCapsuleReleasePayload(canonical), keys.privateKey).toString('base64');
    const authority = authorityFor(canonical, signature, keyId, keys.publicKeyBytes);
    const verified = verifyUbuntuPackageCapsuleReleaseInput(authority);
    if (verified.releaseId !== canonical.releaseId || verified.sequence !== canonical.sequence
        || verified.upstreamKeyFingerprint !== captureEvidence.upstreamKeyFingerprint) {
      fail('Ubuntu capsule release self-verification failed');
    }
    if (signal?.aborted) throw signal.reason ?? new Error('Ubuntu capsule release was interrupted');
    await writeExactFile(path.join(root, UBUNTU_PACKAGE_CAPSULE_MANIFEST_NAME), authority.manifestBytes);
    await writeExactFile(path.join(root, UBUNTU_PACKAGE_CAPSULE_PUBLIC_KEY_NAME), keys.publicKeyBytes);
    return Object.freeze({
      root,
      releaseId: verified.releaseId,
      sequence: verified.sequence,
      snapshot: verified.snapshot,
      manifestName: UBUNTU_PACKAGE_CAPSULE_MANIFEST_NAME,
      manifestSha256: authority.expectedManifestSha256,
      publicKeyName: UBUNTU_PACKAGE_CAPSULE_PUBLIC_KEY_NAME,
      publicKeySha256: authority.expectedPublicKeySha256,
      keyId,
      objectDigests: published.objectDigests,
      metadataObjects: verified.metadata.descriptor.objects.length,
      binaryObjects: verified.binaries.descriptor.objects.length,
      sourceObjects: verified.sources.descriptor.objects.length,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
