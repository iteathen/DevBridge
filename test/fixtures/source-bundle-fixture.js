import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  SOURCE_BUNDLE_FORMAT,
  SOURCE_BUNDLE_MANIFEST_PROTOCOL,
  SOURCE_BUNDLE_OBJECT,
  SOURCE_BUNDLE_RELEASE_PROTOCOL,
  SOURCE_BUNDLE_REPOSITORY,
  sourceBundleReleasePayload,
} from '../../src/bootstrap/source-bundle-release-input.mjs';
import { IMMUTABLE_OBJECT_SET_PROTOCOL } from '../../src/runtime/immutable-object-set.js';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function sourceBundleAuthority({
  bundleBytes = Buffer.from('bundle fixture'),
  head = 'a'.repeat(40),
  tree = 'b'.repeat(40),
  releaseId = 'source-fixture',
  sequence = 1,
  keyId = 'source-fixture-key',
} = {}) {
  const bundle = Buffer.from(bundleBytes);
  const objectSha256 = sha256(bundle);
  const descriptor = {
    protocol: IMMUTABLE_OBJECT_SET_PROTOCOL,
    subject: `devbridge-source-${head}`,
    objects: [{
      name: SOURCE_BUNDLE_OBJECT,
      size: bundle.length,
      sha256: objectSha256,
      chunks: [{ ordinal: 0, name: 'source-000000', offset: 0, size: bundle.length, sha256: objectSha256 }],
    }],
  };
  const release = {
    repository: SOURCE_BUNDLE_REPOSITORY,
    head,
    tree,
    releaseId,
    sequence,
    format: SOURCE_BUNDLE_FORMAT,
    descriptor,
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyBytes = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }));
  const manifestBytes = Buffer.from(JSON.stringify({
    protocol: SOURCE_BUNDLE_MANIFEST_PROTOCOL,
    release,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: sign(null, sourceBundleReleasePayload(release), privateKey).toString('base64'),
    },
  }));
  return Object.freeze({
    authority: Object.freeze({
      manifestBytes,
      publicKeyBytes,
      expectedManifestSha256: sha256(manifestBytes),
      expectedPublicKeySha256: sha256(publicKeyBytes),
      expectedKeyId: keyId,
    }),
    bundleBytes: bundle,
    descriptor,
    head,
    tree,
    objectSha256,
    release,
    releaseProtocol: SOURCE_BUNDLE_RELEASE_PROTOCOL,
  });
}
