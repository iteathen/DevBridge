import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  IMMUTABLE_OBJECT_SET_PROTOCOL,
  immutableObjectSetDigest,
  normalizeImmutableObjectSet,
} from '../runtime/immutable-object-set.js';

export const FIRST_BYTE_MANIFEST_PROTOCOL = 'devbridge/first-byte-release-manifest-v1';
export const FIRST_BYTE_RELEASE_PROTOCOL = 'devbridge/first-byte-release-subject-v1';
export const FIRST_BYTE_REPOSITORY = 'iteathen/DevBridge';

const HEAD = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const KEY_ID = /^[A-Za-z0-9_.:-]+$/u;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_BOOTSTRAP_BYTES = 512 * 1024;
const MAX_BOOTSTRAP_CHUNKS = 16;

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

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function normalizeRelease(raw) {
  const value = exactObject(raw, new Set(['repository', 'head', 'releaseId', 'sequence', 'descriptor']), 'first-byte release');
  if (value.repository !== FIRST_BYTE_REPOSITORY) fail(`first-byte repository must be ${FIRST_BYTE_REPOSITORY}`);
  const head = String(value.head ?? '').toLowerCase();
  if (!HEAD.test(head)) fail('first-byte head must be an exact 40-hex commit');
  if (typeof value.releaseId !== 'string' || !SAFE_ID.test(value.releaseId)) fail('first-byte release identity is invalid');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) fail('first-byte release sequence is invalid');
  const descriptor = normalizeImmutableObjectSet(value.descriptor);
  if (descriptor.subject !== `devbridge-first-byte-${head}`) fail('first-byte descriptor subject does not match the exact head');
  if (descriptor.objects.length !== 1) fail('first-byte descriptor must contain exactly one object');
  const object = descriptor.objects[0];
  if (object.name !== 'bootstrap-devbridge.mjs') fail('first-byte descriptor bootstrap object is invalid');
  if (object.size > MAX_BOOTSTRAP_BYTES || object.chunks.length > MAX_BOOTSTRAP_CHUNKS) {
    fail('first-byte descriptor bootstrap object exceeds its bound');
  }
  return Object.freeze({
    repository: FIRST_BYTE_REPOSITORY,
    head,
    releaseId: value.releaseId,
    sequence: value.sequence,
    descriptor,
    descriptorSha256: immutableObjectSetDigest(descriptor),
  });
}

function payloadForNormalizedRelease(release) {
  return Buffer.from(JSON.stringify({
    protocol: FIRST_BYTE_RELEASE_PROTOCOL,
    repository: release.repository,
    head: release.head,
    releaseId: release.releaseId,
    sequence: release.sequence,
    descriptorSha256: release.descriptorSha256,
  }), 'utf8');
}

export function firstByteReleasePayload(raw) {
  return payloadForNormalizedRelease(normalizeRelease(raw));
}

function normalizeSignature(raw) {
  const value = exactObject(raw, new Set(['algorithm', 'keyId', 'value']), 'first-byte signature');
  if (value.algorithm !== 'ed25519') fail('first-byte signature algorithm must be ed25519');
  if (typeof value.keyId !== 'string' || value.keyId.length > 128 || !KEY_ID.test(value.keyId)) {
    fail('first-byte signature key identity is invalid');
  }
  if (typeof value.value !== 'string' || value.value.length < 1 || value.value.length > 4096
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.value)) {
    fail('first-byte signature value is invalid');
  }
  const bytes = Buffer.from(value.value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value.value) fail('first-byte Ed25519 signature is invalid');
  return Object.freeze({ keyId: value.keyId, bytes });
}

export function verifyFirstByteReleaseInput(raw) {
  const input = exactObject(
    raw,
    new Set(['manifestBytes', 'publicKeyBytes', 'expectedManifestSha256', 'expectedPublicKeySha256', 'expectedKeyId']),
    'first-byte authority',
  );
  const manifestBytes = boundedBytes(input.manifestBytes, 'first-byte manifest', MAX_MANIFEST_BYTES);
  const publicKeyBytes = boundedBytes(input.publicKeyBytes, 'first-byte public key', MAX_KEY_BYTES);
  const expectedManifestSha256 = exactDigest(input.expectedManifestSha256, 'first-byte expected manifest digest');
  const expectedPublicKeySha256 = exactDigest(input.expectedPublicKeySha256, 'first-byte expected public-key digest');
  if (digest(manifestBytes) !== expectedManifestSha256) fail('first-byte manifest digest does not match authority');
  if (digest(publicKeyBytes) !== expectedPublicKeySha256) fail('first-byte public-key digest does not match authority');
  if (typeof input.expectedKeyId !== 'string' || input.expectedKeyId.length > 128 || !KEY_ID.test(input.expectedKeyId)) {
    throw new TypeError('first-byte expected key identity is invalid');
  }

  let parsed;
  try { parsed = JSON.parse(manifestBytes.toString('utf8')); }
  catch { fail('first-byte manifest is not valid JSON'); }
  const manifest = exactObject(parsed, new Set(['protocol', 'release', 'signature']), 'first-byte manifest');
  if (manifest.protocol !== FIRST_BYTE_MANIFEST_PROTOCOL) fail('first-byte manifest protocol is unsupported');
  const release = normalizeRelease(manifest.release);
  const signature = normalizeSignature(manifest.signature);
  if (signature.keyId !== input.expectedKeyId) fail('first-byte signature key identity does not match authority');

  let publicKey;
  try { publicKey = createPublicKey(publicKeyBytes); }
  catch { fail('first-byte public key could not be parsed'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('first-byte public key must be Ed25519');
  if (!verifySignature(null, payloadForNormalizedRelease(release), publicKey, signature.bytes)) {
    fail('first-byte signature verification failed');
  }
  return Object.freeze({
    repository: release.repository,
    head: release.head,
    releaseId: release.releaseId,
    sequence: release.sequence,
    descriptor: release.descriptor,
    descriptorSha256: release.descriptorSha256,
    manifestSha256: expectedManifestSha256,
    publicKeySha256: expectedPublicKeySha256,
    keyId: signature.keyId,
  });
}

export { IMMUTABLE_OBJECT_SET_PROTOCOL };
