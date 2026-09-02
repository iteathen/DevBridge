import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  UBUNTU_PACKAGE_CAPSULE_DISTRIBUTION,
  UBUNTU_PACKAGE_CAPSULE_MANIFEST_PROTOCOL,
  UBUNTU_PACKAGE_CAPSULE_TRANSACTION_PROTOCOL,
  UBUNTU_PACKAGE_STATE_PROTOCOL,
  ubuntuPackageCapsuleReleasePayload,
} from '../../src/setup/ubuntu-package-capsule-release-input.mjs';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function object(name) {
  const bytes = Buffer.from(`fixture:${name}`, 'utf8');
  return {
    name,
    size: bytes.length,
    sha256: sha256(bytes),
    chunks: [{ ordinal: 0, name: `${name}.chunk`, offset: 0, size: bytes.length, sha256: sha256(bytes) }],
  };
}

function descriptor(subject, names) {
  return { protocol: 'devbridge/immutable-object-set-v1', subject, objects: names.map(object) };
}

function metadata(releaseId) {
  const pockets = ['resolute', 'resolute-updates', 'resolute-security'].map((pocket) => ({
    pocket,
    inRelease: { path: `dists/${pocket}/InRelease`, object: `${pocket}-inrelease` },
    components: ['main', 'universe'].map((component) => ({
      component,
      binaryIndex: {
        path: `${component}/binary-amd64/Packages.xz`,
        object: `${pocket}-${component}-binary-index`,
      },
      sourceIndex: {
        path: `${component}/source/Sources.xz`,
        object: `${pocket}-${component}-source-index`,
      },
    })),
  }));
  const names = pockets.flatMap((pocket) => [
    pocket.inRelease.object,
    ...pocket.components.flatMap((component) => [component.binaryIndex.object, component.sourceIndex.object]),
  ]);
  return { descriptor: descriptor(`ubuntu-capsule-${releaseId}-metadata`, names), pockets };
}

function binaries(releaseId) {
  const packages = [
    {
      package: 'build-essential', version: '12.12ubuntu1', architecture: 'amd64',
      source: 'build-essential', sourceVersion: '12.12ubuntu1',
      filename: 'pool/main/b/build-essential/build-essential_12.12ubuntu1_amd64.deb', object: 'binary-build-essential',
    },
    {
      package: 'cmake', version: '3.31.6-1ubuntu1', architecture: 'amd64',
      source: 'cmake', sourceVersion: '3.31.6-1ubuntu1',
      filename: 'pool/main/c/cmake/cmake_3.31.6-1ubuntu1_amd64.deb', object: 'binary-cmake',
    },
    {
      package: 'libc6', version: '2.41-6ubuntu1', architecture: 'amd64',
      source: 'glibc', sourceVersion: '2.41-6ubuntu1',
      filename: 'pool/main/g/glibc/libc6_2.41-6ubuntu1_amd64.deb', object: 'binary-libc6',
    },
  ];
  return { descriptor: descriptor(`ubuntu-capsule-${releaseId}-binary`, packages.map((entry) => entry.object)), packages };
}

function sources(releaseId) {
  const packages = [
    {
      package: 'build-essential', version: '12.12ubuntu1', directory: 'pool/main/b/build-essential',
      dsc: { filename: 'build-essential_12.12ubuntu1.dsc', object: 'source-build-essential-dsc' },
      files: [{ filename: 'build-essential_12.12ubuntu1.tar.xz', object: 'source-build-essential-tar' }],
    },
    {
      package: 'cmake', version: '3.31.6-1ubuntu1', directory: 'pool/main/c/cmake',
      dsc: { filename: 'cmake_3.31.6-1ubuntu1.dsc', object: 'source-cmake-dsc' },
      files: [
        { filename: 'cmake_3.31.6.orig.tar.gz', object: 'source-cmake-orig' },
        { filename: 'cmake_3.31.6-1ubuntu1.debian.tar.xz', object: 'source-cmake-debian' },
      ],
    },
    {
      package: 'glibc', version: '2.41-6ubuntu1', directory: 'pool/main/g/glibc',
      dsc: { filename: 'glibc_2.41-6ubuntu1.dsc', object: 'source-glibc-dsc' },
      files: [
        { filename: 'glibc_2.41.orig.tar.xz', object: 'source-glibc-orig' },
        { filename: 'glibc_2.41-6ubuntu1.debian.tar.xz', object: 'source-glibc-debian' },
      ],
    },
  ];
  const names = packages.flatMap((entry) => [entry.dsc.object, ...entry.files.map((file) => file.object)]);
  return { descriptor: descriptor(`ubuntu-capsule-${releaseId}-source`, names), packages };
}

export function ubuntuPackageCapsuleRelease() {
  const releaseId = 'ubuntu-resolute-20260821-1';
  return {
    distribution: UBUNTU_PACKAGE_CAPSULE_DISTRIBUTION,
    release: '26.04',
    codename: 'resolute',
    architecture: 'amd64',
    snapshot: '20260821T230000Z',
    baseMediaSha256: 'a'.repeat(64),
    releaseId,
    sequence: 1,
    upstreamKeyFingerprint: '843938DF228D22F7B3742BC0D94AA3F0EFE21092',
    transaction: {
      protocol: UBUNTU_PACKAGE_CAPSULE_TRANSACTION_PROTOCOL,
      packageStateProtocol: UBUNTU_PACKAGE_STATE_PROTOCOL,
      basePackageStateSha256: 'b'.repeat(64),
      resultPackageStateSha256: 'c'.repeat(64),
      requestedPackages: [
        { name: 'build-essential', version: '12.12ubuntu1' },
        { name: 'cmake', version: '3.31.6-1ubuntu1' },
      ],
    },
    metadata: metadata(releaseId),
    binaries: binaries(releaseId),
    sources: sources(releaseId),
  };
}

export function ubuntuPackageCapsuleAuthority({ release = ubuntuPackageCapsuleRelease() } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyBytes = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }));
  const signature = sign(null, ubuntuPackageCapsuleReleasePayload(release), privateKey).toString('base64');
  const manifestBytes = Buffer.from(JSON.stringify({
    protocol: UBUNTU_PACKAGE_CAPSULE_MANIFEST_PROTOCOL,
    release,
    signature: { algorithm: 'ed25519', keyId: 'ubuntu-capsule-test-key', value: signature },
  }), 'utf8');
  return {
    release,
    manifestBytes,
    publicKeyBytes,
    authority: {
      manifestBytes,
      publicKeyBytes,
      expectedManifestSha256: sha256(manifestBytes),
      expectedPublicKeySha256: sha256(publicKeyBytes),
      expectedKeyId: 'ubuntu-capsule-test-key',
    },
  };
}
