import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  immutableObjectSetDigest,
  normalizeImmutableObjectSet,
} from '../runtime/immutable-object-set.js';

export const SOURCE_BUNDLE_MANIFEST_PROTOCOL = 'devbridge/source-bundle-release-manifest-v1';
export const SOURCE_BUNDLE_RELEASE_PROTOCOL = 'devbridge/source-bundle-release-subject-v1';
export const SOURCE_BUNDLE_REPOSITORY = 'iteathen/DevBridge';
export const SOURCE_BUNDLE_FORMAT = 'git-bundle-v2';
export const SOURCE_BUNDLE_OBJECT = 'devbridge-source.bundle';

const OBJECT_FORMAT = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const KEY_ID = /^[A-Za-z0-9_.:-]+$/u;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_CHUNKS = 16_384;

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function exactDigest(value, name) {
  const selected = String(value ?? '').toLowerCase();
  if (!DIGEST.test(selected)) throw new TypeError(`${name} is invalid`);
  return selected;
}

function boundedBytes(value, name, maximum) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    throw new TypeError(`${name} bytes are invalid`);
  }
  return Buffer.from(value);
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function normalizeRelease(raw) {
  const value = exactObject(
    raw,
    new Set(['repository', 'head', 'tree', 'releaseId', 'sequence', 'format', 'descriptor']),
    'source-bundle release',
  );
  if (value.repository !== SOURCE_BUNDLE_REPOSITORY) fail(`source-bundle repository must be ${SOURCE_BUNDLE_REPOSITORY}`);
  const head = String(value.head ?? '').toLowerCase();
  const tree = String(value.tree ?? '').toLowerCase();
  if (!OBJECT_FORMAT.test(head)) fail('source-bundle head must be an exact 40-hex commit');
  if (!OBJECT_FORMAT.test(tree)) fail('source-bundle tree must be an exact 40-hex tree');
  if (typeof value.releaseId !== 'string' || !SAFE_ID.test(value.releaseId)) fail('source-bundle release identity is invalid');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) fail('source-bundle release sequence is invalid');
  if (value.format !== SOURCE_BUNDLE_FORMAT) fail('source-bundle format is unsupported');
  const descriptor = normalizeImmutableObjectSet(value.descriptor);
  if (descriptor.subject !== `devbridge-source-${head}`) fail('source-bundle descriptor subject does not match the exact head');
  if (descriptor.objects.length !== 1 || descriptor.objects[0].name !== SOURCE_BUNDLE_OBJECT) {
    fail('source-bundle descriptor must contain exactly one source bundle object');
  }
  const object = descriptor.objects[0];
  if (object.size > MAX_BUNDLE_BYTES || object.chunks.length > MAX_BUNDLE_CHUNKS) {
    fail('source-bundle object exceeds its bound');
  }
  return Object.freeze({
    repository: SOURCE_BUNDLE_REPOSITORY,
    head,
    tree,
    releaseId: value.releaseId,
    sequence: value.sequence,
    format: SOURCE_BUNDLE_FORMAT,
    descriptor,
    descriptorSha256: immutableObjectSetDigest(descriptor),
  });
}

function payloadForNormalizedRelease(release) {
  return Buffer.from(JSON.stringify({
    protocol: SOURCE_BUNDLE_RELEASE_PROTOCOL,
    repository: release.repository,
    head: release.head,
    tree: release.tree,
    releaseId: release.releaseId,
    sequence: release.sequence,
    format: release.format,
    descriptorSha256: release.descriptorSha256,
  }), 'utf8');
}

export function sourceBundleReleasePayload(raw) {
  return payloadForNormalizedRelease(normalizeRelease(raw));
}

function normalizeSignature(raw) {
  const value = exactObject(raw, new Set(['algorithm', 'keyId', 'value']), 'source-bundle signature');
  if (value.algorithm !== 'ed25519') fail('source-bundle signature algorithm must be ed25519');
  if (typeof value.keyId !== 'string' || value.keyId.length > 128 || !KEY_ID.test(value.keyId)) {
    fail('source-bundle signature key identity is invalid');
  }
  if (typeof value.value !== 'string' || value.value.length < 1 || value.value.length > 4096
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.value)) {
    fail('source-bundle signature value is invalid');
  }
  const bytes = Buffer.from(value.value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value.value) fail('source-bundle Ed25519 signature is invalid');
  return Object.freeze({ keyId: value.keyId, bytes });
}

export function verifySourceBundleReleaseInput(raw) {
  const input = exactObject(
    raw,
    new Set(['manifestBytes', 'publicKeyBytes', 'expectedManifestSha256', 'expectedPublicKeySha256', 'expectedKeyId']),
    'source-bundle authority',
  );
  const manifestBytes = boundedBytes(input.manifestBytes, 'source-bundle manifest', MAX_MANIFEST_BYTES);
  const publicKeyBytes = boundedBytes(input.publicKeyBytes, 'source-bundle public key', MAX_KEY_BYTES);
  const expectedManifestSha256 = exactDigest(input.expectedManifestSha256, 'source-bundle expected manifest digest');
  const expectedPublicKeySha256 = exactDigest(input.expectedPublicKeySha256, 'source-bundle expected public-key digest');
  if (sha256(manifestBytes) !== expectedManifestSha256) fail('source-bundle manifest digest does not match authority');
  if (sha256(publicKeyBytes) !== expectedPublicKeySha256) fail('source-bundle public-key digest does not match authority');
  if (typeof input.expectedKeyId !== 'string' || input.expectedKeyId.length > 128 || !KEY_ID.test(input.expectedKeyId)) {
    throw new TypeError('source-bundle expected key identity is invalid');
  }

  let parsed;
  try { parsed = JSON.parse(manifestBytes.toString('utf8')); }
  catch { fail('source-bundle manifest is not valid JSON'); }
  const manifest = exactObject(parsed, new Set(['protocol', 'release', 'signature']), 'source-bundle manifest');
  if (manifest.protocol !== SOURCE_BUNDLE_MANIFEST_PROTOCOL) fail('source-bundle manifest protocol is unsupported');
  const release = normalizeRelease(manifest.release);
  const signature = normalizeSignature(manifest.signature);
  if (signature.keyId !== input.expectedKeyId) fail('source-bundle signature key identity does not match authority');

  let publicKey;
  try { publicKey = createPublicKey(publicKeyBytes); }
  catch { fail('source-bundle public key could not be parsed'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('source-bundle public key must be Ed25519');
  if (!verifySignature(null, payloadForNormalizedRelease(release), publicKey, signature.bytes)) {
    fail('source-bundle signature verification failed');
  }
  return Object.freeze({
    repository: release.repository,
    head: release.head,
    tree: release.tree,
    releaseId: release.releaseId,
    sequence: release.sequence,
    format: release.format,
    descriptor: release.descriptor,
    descriptorSha256: release.descriptorSha256,
    manifestSha256: expectedManifestSha256,
    publicKeySha256: expectedPublicKeySha256,
    keyId: signature.keyId,
  });
}
