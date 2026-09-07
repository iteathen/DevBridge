import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  FIRST_BYTE_MANIFEST_PROTOCOL,
  FIRST_BYTE_REPOSITORY,
  firstByteReleasePayload,
} from '../../src/bootstrap/first-byte-release-input.mjs';
import { IMMUTABLE_OBJECT_SET_PROTOCOL } from '../../src/runtime/immutable-object-set.js';

export const HEAD = 'a'.repeat(40);
export const BYTES = Buffer.from('export async function runZeroStateBootstrap() { return { status: 0 }; }\n');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
export const PUBLIC_KEY = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }), 'utf8');

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

export function descriptor(bytes = BYTES) {
  return {
    protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
    subject: `devbridge-first-byte-${HEAD}`,
    objects: [{
      name: 'bootstrap-devbridge.mjs',
      size: bytes.length,
      sha256: sha256(bytes),
      chunks: [{ ordinal: 0, name: 'bootstrap.part-000000', offset: 0, size: bytes.length, sha256: sha256(bytes) }],
    }],
  };
}

export function release(overrides = {}) {
  return {
    repository: FIRST_BYTE_REPOSITORY,
    head: HEAD,
    releaseId: 'stage8-first-byte-1',
    sequence: 1,
    descriptor: descriptor(),
    ...overrides,
  };
}

export function manifestBytes(value = release(), keyId = 'release-test-key') {
  const signature = sign(null, firstByteReleasePayload(value), privateKey).toString('base64');
  return Buffer.from(JSON.stringify({
    protocol: FIRST_BYTE_MANIFEST_PROTOCOL,
    release: value,
    signature: { algorithm: 'ed25519', keyId, value: signature },
  }), 'utf8');
}

export function authority(bytes = manifestBytes(), overrides = {}) {
  return {
    manifestBytes: bytes,
    publicKeyBytes: PUBLIC_KEY,
    expectedManifestSha256: sha256(bytes),
    expectedPublicKeySha256: sha256(PUBLIC_KEY),
    expectedKeyId: 'release-test-key',
    ...overrides,
  };
}
