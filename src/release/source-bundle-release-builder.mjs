import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { lstat, link, mkdir, open, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { sameObservedFilesystemIdentity } from '../runtime/local-filesystem-identity.js';
import {
  IMMUTABLE_OBJECT_SET_PROTOCOL,
  normalizeImmutableObjectSet,
} from '../runtime/immutable-object-set.js';
import {
  SOURCE_BUNDLE_FORMAT,
  SOURCE_BUNDLE_MANIFEST_PROTOCOL,
  SOURCE_BUNDLE_OBJECT,
  SOURCE_BUNDLE_REPOSITORY,
  sourceBundleReleasePayload,
  verifySourceBundleReleaseInput,
} from '../bootstrap/source-bundle-release-input.mjs';
import { GitSourceBundleProducer } from './git-source-bundle-producer.mjs';

export const DEFAULT_SOURCE_BUNDLE_CHUNK_BYTES = 64 * 1024 * 1024;
export const SOURCE_BUNDLE_RELEASE_MANIFEST_NAME = 'source-bundle-manifest.json';
export const SOURCE_BUNDLE_RELEASE_PUBLIC_KEY_NAME = 'source-bundle-public-key.pem';
export const SOURCE_BUNDLE_RELEASE_OBJECT_DIRECTORY = 'objects';

const OBJECT_FORMAT = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const KEY_ID = /^[A-Za-z0-9_.:-]+$/u;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_CHUNKS = 16_384;
const COPY_BYTES = 4 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function boundedBytes(value, name) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_KEY_BYTES) {
    throw new TypeError(`${name} bytes are invalid`);
  }
  return Buffer.from(value);
}

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function createOwnedDirectory(directory) {
  try { await mkdir(directory, { recursive: false, mode: 0o700 }); }
  catch (error) { if (error?.code === 'EEXIST') fail('source-bundle release destination already exists'); throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('source-bundle release destination must be a real directory');
}

async function writeAll(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (bytesWritten < 1) fail('source-bundle release output write did not advance');
    offset += bytesWritten;
  }
}

async function writeExactFile(location, bytes) {
  const handle = await open(location, 'wx', 0o600);
  try { await writeAll(handle, bytes, 0); await handle.sync(); }
  finally { await handle.close(); }
}

async function measureExactFile(location, expectedSize, expectedSha256) {
  const info = await lstat(location, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size !== BigInt(expectedSize)) return false;
  const bytes = await readFile(location);
  return bytes.length === expectedSize && sha256(bytes) === expectedSha256;
}

async function publishChunk(temporary, destination, size, digest) {
  try {
    await link(temporary, destination);
    await unlink(temporary);
  } catch (error) {
    if (error?.code !== 'EEXIST' || !await measureExactFile(destination, size, digest)) throw error;
    await unlink(temporary);
  }
}

async function chunkBundle(bundle, objectRoot, chunkBytes) {
  const before = await lstat(bundle, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(MAX_BUNDLE_BYTES)) {
    fail('source-bundle release object is invalid or exceeds its bound');
  }
  const size = Number(before.size);
  const chunkCount = Math.ceil(size / chunkBytes);
  if (chunkCount > MAX_BUNDLE_CHUNKS) fail('source-bundle release object requires too many chunks');
  const input = await open(bundle, 'r');
  const held = await input.stat({ bigint: true });
  if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) fail('source-bundle release object changed while opening');
  const whole = createHash('sha256');
  const chunks = [];
  try {
    let sourceOffset = 0;
    for (let ordinal = 0; sourceOffset < size; ordinal += 1) {
      const selectedSize = Math.min(chunkBytes, size - sourceOffset);
      const temporary = path.join(objectRoot, `.chunk-${String(ordinal).padStart(6, '0')}.tmp`);
      const output = await open(temporary, 'wx', 0o600);
      const chunkHash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.min(COPY_BYTES, selectedSize));
      let copied = 0;
      try {
        while (copied < selectedSize) {
          const requested = Math.min(buffer.length, selectedSize - copied);
          const { bytesRead } = await input.read(buffer, 0, requested, sourceOffset + copied);
          if (bytesRead !== requested) fail('source-bundle release object ended while chunking');
          const frame = buffer.subarray(0, bytesRead);
          await writeAll(output, frame, copied);
          chunkHash.update(frame);
          whole.update(frame);
          copied += bytesRead;
        }
        await output.sync();
      } finally { await output.close(); }
      const digest = chunkHash.digest('hex');
      await publishChunk(temporary, path.join(objectRoot, digest), selectedSize, digest);
      chunks.push(Object.freeze({
        ordinal,
        name: `source-${String(ordinal).padStart(6, '0')}`,
        offset: sourceOffset,
        size: selectedSize,
        sha256: digest,
      }));
      sourceOffset += selectedSize;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await input.read(extra, 0, 1, size)).bytesRead !== 0) fail('source-bundle release object grew while chunking');
    const after = await lstat(bundle, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(held, after)) {
      fail('source-bundle release object changed while chunking');
    }
    return Object.freeze({ size, sha256: whole.digest('hex'), chunks: Object.freeze(chunks) });
  } finally { await input.close(); }
}

function signingKeys(privateKeyBytes, publicKeyBytes) {
  let privateKey;
  let publicKey;
  try { privateKey = createPrivateKey(boundedBytes(privateKeyBytes, 'source-bundle private key')); }
  catch { fail('source-bundle private key could not be parsed'); }
  try { publicKey = createPublicKey(boundedBytes(publicKeyBytes, 'source-bundle public key')); }
  catch { fail('source-bundle public key could not be parsed'); }
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    fail('source-bundle release signing keys must be Ed25519');
  }
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const supplied = publicKey.export({ type: 'spki', format: 'der' });
  if (!derived.equals(supplied)) fail('source-bundle release signing keys do not match');
  return Object.freeze({ privateKey, publicKeyBytes: Buffer.from(publicKeyBytes) });
}

export async function buildSourceBundleRelease({
  repository,
  destination,
  head,
  releaseId,
  sequence,
  keyId,
  privateKeyBytes,
  publicKeyBytes,
  chunkBytes = DEFAULT_SOURCE_BUNDLE_CHUNK_BYTES,
  bundleProducer = new GitSourceBundleProducer(),
  signal = null,
} = {}) {
  const selectedHead = String(head ?? '').toLowerCase();
  if (!OBJECT_FORMAT.test(selectedHead)) throw new TypeError('source-bundle release head is invalid');
  if (typeof repository !== 'string' || !path.isAbsolute(repository) || repository.includes('\0')) {
    throw new TypeError('source-bundle release repository is invalid');
  }
  if (typeof releaseId !== 'string' || !SAFE_ID.test(releaseId)) throw new TypeError('source-bundle release identity is invalid');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('source-bundle release sequence is invalid');
  if (typeof keyId !== 'string' || keyId.length > 128 || !KEY_ID.test(keyId)) throw new TypeError('source-bundle release key identity is invalid');
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) {
    throw new TypeError('source-bundle release output directory is invalid');
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_BUNDLE_BYTES) {
    throw new TypeError('source-bundle release chunk size is invalid');
  }
  if (!bundleProducer || typeof bundleProducer.create !== 'function') throw new TypeError('source-bundle producer port is invalid');
  if (signal != null && typeof signal !== 'object') throw new TypeError('source-bundle release signal is invalid');
  if (signal?.aborted) throw signal.reason ?? new Error('source-bundle release was interrupted');
  const keys = signingKeys(privateKeyBytes, publicKeyBytes);
  const root = path.resolve(destination);
  await createOwnedDirectory(root);
  const bundle = path.join(root, '.devbridge-source.bundle.pending');
  try {
    const produced = await bundleProducer.create({ repository, destination: bundle, head: selectedHead, signal });
    if (produced?.head !== selectedHead || !OBJECT_FORMAT.test(String(produced?.tree ?? ''))
        || path.resolve(produced?.location ?? '') !== bundle) {
      fail('source-bundle producer evidence does not match the release request');
    }
    const objectRoot = path.join(root, SOURCE_BUNDLE_RELEASE_OBJECT_DIRECTORY);
    await mkdir(objectRoot, { mode: 0o700 });
    const measured = await chunkBundle(bundle, objectRoot, chunkBytes);
    const descriptor = normalizeImmutableObjectSet({
      protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
      subject: `devbridge-source-${selectedHead}`,
      objects: [{ name: SOURCE_BUNDLE_OBJECT, size: measured.size, sha256: measured.sha256, chunks: measured.chunks }],
    });
    const release = Object.freeze({
      repository: SOURCE_BUNDLE_REPOSITORY,
      head: selectedHead,
      tree: produced.tree,
      releaseId,
      sequence,
      format: SOURCE_BUNDLE_FORMAT,
      descriptor,
    });
    const signature = sign(null, sourceBundleReleasePayload(release), keys.privateKey).toString('base64');
    const manifestBytes = Buffer.from(JSON.stringify({
      protocol: SOURCE_BUNDLE_MANIFEST_PROTOCOL,
      release,
      signature: { algorithm: 'ed25519', keyId, value: signature },
    }), 'utf8');
    const manifestSha256 = sha256(manifestBytes);
    const publicKeySha256 = sha256(keys.publicKeyBytes);
    const authority = Object.freeze({
      manifestBytes,
      publicKeyBytes: keys.publicKeyBytes,
      expectedManifestSha256: manifestSha256,
      expectedPublicKeySha256: publicKeySha256,
      expectedKeyId: keyId,
    });
    const verified = verifySourceBundleReleaseInput(authority);
    if (verified.head !== selectedHead || verified.tree !== produced.tree || verified.descriptor.objects[0].sha256 !== measured.sha256) {
      fail('source-bundle release self-verification failed');
    }
    await writeExactFile(path.join(root, SOURCE_BUNDLE_RELEASE_MANIFEST_NAME), manifestBytes);
    await writeExactFile(path.join(root, SOURCE_BUNDLE_RELEASE_PUBLIC_KEY_NAME), keys.publicKeyBytes);
    await rm(bundle, { force: true });
    return Object.freeze({
      root,
      head: verified.head,
      tree: verified.tree,
      descriptor: verified.descriptor,
      manifestName: SOURCE_BUNDLE_RELEASE_MANIFEST_NAME,
      manifestSha256,
      publicKeyName: SOURCE_BUNDLE_RELEASE_PUBLIC_KEY_NAME,
      publicKeySha256,
      keyId,
      objectDigests: Object.freeze([...new Set(measured.chunks.map((chunk) => chunk.sha256))]),
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
