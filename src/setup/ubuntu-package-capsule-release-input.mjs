import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  immutableObjectSetDigest,
  normalizeImmutableObjectSet,
} from '../runtime/immutable-object-set.js';

export const UBUNTU_PACKAGE_CAPSULE_MANIFEST_PROTOCOL = 'devbridge/ubuntu-package-capsule-release-manifest-v1';
export const UBUNTU_PACKAGE_CAPSULE_RELEASE_PROTOCOL = 'devbridge/ubuntu-package-capsule-release-subject-v1';
export const UBUNTU_PACKAGE_CAPSULE_TRANSACTION_PROTOCOL = 'devbridge/ubuntu-apt-upgrade-install-v1';
export const UBUNTU_PACKAGE_STATE_PROTOCOL = 'devbridge/dpkg-installed-package-state-v1';
export const UBUNTU_PACKAGE_CAPSULE_DISTRIBUTION = 'ubuntu';

const DIGEST = /^[a-f0-9]{64}$/u;
const FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,95}$/u;
const KEY_ID = /^[A-Za-z0-9_.:-]+$/u;
const RELEASE = /^[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?$/u;
const CODENAME = /^[a-z][a-z0-9-]{0,31}$/u;
const ARCHITECTURE = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{0,99}$/u;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,199}$/u;
const SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const MUTABLE_VERSION = /^(?:latest|stable|current|head|main|master)$/iu;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_REQUESTED_PACKAGES = 256;
const MAX_BINARY_PACKAGES = 8192;
const MAX_SOURCE_PACKAGES = 8192;
const COMPONENTS = Object.freeze(['main', 'universe']);

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function exactDigest(value, name) {
  const normalized = String(value ?? '').toLowerCase();
  if (!DIGEST.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function boundedBytes(value, name, maximum) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    throw new TypeError(`${name} bytes are invalid`);
  }
  return Buffer.from(value);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function packageName(value, name) {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function packageVersion(value, name) {
  if (typeof value !== 'string' || !PACKAGE_VERSION.test(value) || !/\d/u.test(value) || MUTABLE_VERSION.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function archivePath(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.startsWith('/') || value.endsWith('/')
      || value.includes('\\') || value.includes('//') || /[?#\u0000-\u001f\u007f]/u.test(value)
      || !/^[A-Za-z0-9._+%~/-]+$/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  for (const segment of value.split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new TypeError(`${name} is invalid`); }
    if (!segment || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')
        || /[\u0000-\u001f\u007f]/u.test(decoded)) throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function archiveLeaf(value, name) {
  const normalized = archivePath(value, name);
  if (normalized.includes('/')) throw new TypeError(`${name} must be a filename`);
  return normalized;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function semanticDigest(value) {
  return sha256(Buffer.from(JSON.stringify(stable(value)), 'utf8'));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function objectMap(descriptor) {
  return new Map(descriptor.objects.map((object) => [object.name, object]));
}

function objectReference(value, objects, name) {
  if (typeof value !== 'string' || !objects.has(value)) throw new TypeError(`${name} does not identify a descriptor object`);
  return value;
}

function requireExactCoverage(descriptor, used, name) {
  if (used.size !== descriptor.objects.length || descriptor.objects.some((object) => !used.has(object.name))) {
    throw new TypeError(`${name} inventory does not exactly cover its immutable object set`);
  }
}

function claimObject(name, used, context) {
  if (used.has(name)) throw new TypeError(`${context} reuses an immutable object`);
  used.add(name);
  return name;
}

function normalizeTransaction(raw) {
  const value = exactObject(
    raw,
    new Set(['protocol', 'packageStateProtocol', 'basePackageStateSha256', 'resultPackageStateSha256', 'requestedPackages']),
    'Ubuntu capsule transaction',
  );
  if (value.protocol !== UBUNTU_PACKAGE_CAPSULE_TRANSACTION_PROTOCOL) fail('Ubuntu capsule transaction protocol is unsupported');
  if (value.packageStateProtocol !== UBUNTU_PACKAGE_STATE_PROTOCOL) fail('Ubuntu capsule package-state protocol is unsupported');
  if (!Array.isArray(value.requestedPackages) || value.requestedPackages.length < 1
      || value.requestedPackages.length > MAX_REQUESTED_PACKAGES) {
    throw new TypeError('Ubuntu capsule requested package set is invalid');
  }
  const seen = new Set();
  const requestedPackages = value.requestedPackages.map((rawPackage, index) => {
    const item = exactObject(rawPackage, new Set(['name', 'version']), `Ubuntu capsule requested package ${index}`);
    const name = packageName(item.name, `Ubuntu capsule requested package ${index}.name`);
    if (seen.has(name)) throw new TypeError('Ubuntu capsule requested package names must be unique');
    seen.add(name);
    return Object.freeze({ name, version: packageVersion(item.version, `Ubuntu capsule requested package ${index}.version`) });
  }).sort((left, right) => compareText(left.name, right.name));
  return Object.freeze({
    protocol: UBUNTU_PACKAGE_CAPSULE_TRANSACTION_PROTOCOL,
    packageStateProtocol: UBUNTU_PACKAGE_STATE_PROTOCOL,
    basePackageStateSha256: exactDigest(value.basePackageStateSha256, 'Ubuntu capsule base package-state digest'),
    resultPackageStateSha256: exactDigest(value.resultPackageStateSha256, 'Ubuntu capsule result package-state digest'),
    requestedPackages: Object.freeze(requestedPackages),
  });
}

function expectedDescriptorSubject(releaseId, kind) {
  return `ubuntu-capsule-${releaseId}-${kind}`;
}

function normalizeIndex(raw, { context, expectedPath, objects, used }) {
  const value = exactObject(raw, new Set(['path', 'object']), context);
  const path = archivePath(value.path, `${context}.path`);
  if (!expectedPath.test(path)) throw new TypeError(`${context}.path does not match its pocket/component/architecture`);
  const object = objectReference(value.object, objects, `${context}.object`);
  claimObject(object, used, context);
  return Object.freeze({ path, object });
}

function normalizeMetadata(raw, { releaseId, codename, architecture }) {
  const value = exactObject(raw, new Set(['descriptor', 'pockets']), 'Ubuntu capsule metadata');
  const descriptor = normalizeImmutableObjectSet(value.descriptor);
  if (descriptor.subject !== expectedDescriptorSubject(releaseId, 'metadata')) {
    throw new TypeError('Ubuntu capsule metadata descriptor subject is invalid');
  }
  if (!Array.isArray(value.pockets) || value.pockets.length !== 3) throw new TypeError('Ubuntu capsule metadata pockets are invalid');
  const expectedPockets = [codename, `${codename}-updates`, `${codename}-security`];
  const byPocket = new Map();
  for (const rawPocket of value.pockets) {
    const pocket = exactObject(rawPocket, new Set(['pocket', 'inRelease', 'components']), 'Ubuntu capsule metadata pocket');
    if (typeof pocket.pocket !== 'string' || !expectedPockets.includes(pocket.pocket) || byPocket.has(pocket.pocket)) {
      throw new TypeError('Ubuntu capsule metadata pocket identity is invalid');
    }
    byPocket.set(pocket.pocket, pocket);
  }
  const objects = objectMap(descriptor);
  const used = new Set();
  const pockets = expectedPockets.map((pocketName) => {
    const pocket = byPocket.get(pocketName);
    const inRelease = exactObject(pocket.inRelease, new Set(['path', 'object']), `Ubuntu capsule ${pocketName} InRelease`);
    const inReleasePath = archivePath(inRelease.path, `Ubuntu capsule ${pocketName} InRelease.path`);
    if (inReleasePath !== `dists/${pocketName}/InRelease`) throw new TypeError(`Ubuntu capsule ${pocketName} InRelease.path is invalid`);
    const inReleaseObject = objectReference(inRelease.object, objects, `Ubuntu capsule ${pocketName} InRelease.object`);
    claimObject(inReleaseObject, used, `Ubuntu capsule ${pocketName} InRelease`);
    if (!Array.isArray(pocket.components) || pocket.components.length !== COMPONENTS.length) {
      throw new TypeError(`Ubuntu capsule ${pocketName} components are invalid`);
    }
    const byComponent = new Map();
    for (const rawComponent of pocket.components) {
      const component = exactObject(rawComponent, new Set(['component', 'binaryIndex', 'sourceIndex']), `Ubuntu capsule ${pocketName} component`);
      if (!COMPONENTS.includes(component.component) || byComponent.has(component.component)) {
        throw new TypeError(`Ubuntu capsule ${pocketName} component identity is invalid`);
      }
      byComponent.set(component.component, component);
    }
    const components = COMPONENTS.map((componentName) => {
      const component = byComponent.get(componentName);
      const escapedComponent = componentName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const escapedArchitecture = architecture.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return Object.freeze({
        component: componentName,
        binaryIndex: normalizeIndex(component.binaryIndex, {
          context: `Ubuntu capsule ${pocketName}/${componentName} binary index`,
          expectedPath: new RegExp(`^${escapedComponent}/binary-${escapedArchitecture}/Packages(?:\\.(?:gz|xz))?$`, 'u'),
          objects,
          used,
        }),
        sourceIndex: normalizeIndex(component.sourceIndex, {
          context: `Ubuntu capsule ${pocketName}/${componentName} source index`,
          expectedPath: new RegExp(`^${escapedComponent}/source/Sources(?:\\.(?:gz|xz))?$`, 'u'),
          objects,
          used,
        }),
      });
    });
    return Object.freeze({
      pocket: pocketName,
      inRelease: Object.freeze({ path: inReleasePath, object: inReleaseObject }),
      components: Object.freeze(components),
    });
  });
  requireExactCoverage(descriptor, used, 'Ubuntu capsule metadata');
  return Object.freeze({
    descriptor,
    descriptorSha256: immutableObjectSetDigest(descriptor),
    pockets: Object.freeze(pockets),
    inventorySha256: semanticDigest(pockets),
  });
}

function normalizeBinaries(raw, { releaseId, architecture, transaction }) {
  const value = exactObject(raw, new Set(['descriptor', 'packages']), 'Ubuntu capsule binaries');
  const descriptor = normalizeImmutableObjectSet(value.descriptor);
  if (descriptor.subject !== expectedDescriptorSubject(releaseId, 'binary')) {
    throw new TypeError('Ubuntu capsule binary descriptor subject is invalid');
  }
  if (!Array.isArray(value.packages) || value.packages.length < 1 || value.packages.length > MAX_BINARY_PACKAGES) {
    throw new TypeError('Ubuntu capsule binary inventory is invalid');
  }
  const objects = objectMap(descriptor);
  const used = new Set();
  const identities = new Set();
  const names = new Set();
  const packages = value.packages.map((rawPackage, index) => {
    const item = exactObject(
      rawPackage,
      new Set(['package', 'version', 'architecture', 'source', 'sourceVersion', 'filename', 'object']),
      `Ubuntu capsule binary ${index}`,
    );
    const name = packageName(item.package, `Ubuntu capsule binary ${index}.package`);
    const version = packageVersion(item.version, `Ubuntu capsule binary ${index}.version`);
    const selectedArchitecture = String(item.architecture ?? '');
    if (selectedArchitecture !== architecture && selectedArchitecture !== 'all') {
      throw new TypeError(`Ubuntu capsule binary ${index}.architecture is incompatible`);
    }
    const identity = `${name}\0${selectedArchitecture}`;
    if (identities.has(identity) || names.has(name)) throw new TypeError('Ubuntu capsule binary package identities must be unique');
    identities.add(identity);
    names.add(name);
    const filename = archivePath(item.filename, `Ubuntu capsule binary ${index}.filename`);
    if (!filename.endsWith('.deb')) throw new TypeError(`Ubuntu capsule binary ${index}.filename must identify a .deb`);
    const object = objectReference(item.object, objects, `Ubuntu capsule binary ${index}.object`);
    claimObject(object, used, `Ubuntu capsule binary ${index}`);
    return Object.freeze({
      package: name,
      version,
      architecture: selectedArchitecture,
      source: packageName(item.source, `Ubuntu capsule binary ${index}.source`),
      sourceVersion: packageVersion(item.sourceVersion, `Ubuntu capsule binary ${index}.sourceVersion`),
      filename,
      object,
    });
  }).sort((left, right) => compareText(left.package, right.package));
  requireExactCoverage(descriptor, used, 'Ubuntu capsule binary');
  for (const requested of transaction.requestedPackages) {
    if (!packages.some((item) => item.package === requested.name && item.version === requested.version)) {
      throw new TypeError(`Ubuntu capsule requested package ${requested.name} is absent from the binary transaction`);
    }
  }
  return Object.freeze({
    descriptor,
    descriptorSha256: immutableObjectSetDigest(descriptor),
    packages: Object.freeze(packages),
    inventorySha256: semanticDigest(packages),
  });
}

function normalizeSourceFile(raw, { context, directory, objects, used, suffix = null }) {
  const value = exactObject(raw, new Set(['filename', 'object']), context);
  const filename = archiveLeaf(value.filename, `${context}.filename`);
  archivePath(`${directory}/${filename}`, `${context}.path`);
  if (suffix && !filename.endsWith(suffix)) throw new TypeError(`${context}.filename must identify a ${suffix}`);
  const object = objectReference(value.object, objects, `${context}.object`);
  claimObject(object, used, context);
  return Object.freeze({ filename, object });
}

function normalizeSources(raw, { releaseId, binaries }) {
  const value = exactObject(raw, new Set(['descriptor', 'packages']), 'Ubuntu capsule sources');
  const descriptor = normalizeImmutableObjectSet(value.descriptor);
  if (descriptor.subject !== expectedDescriptorSubject(releaseId, 'source')) {
    throw new TypeError('Ubuntu capsule source descriptor subject is invalid');
  }
  if (!Array.isArray(value.packages) || value.packages.length < 1 || value.packages.length > MAX_SOURCE_PACKAGES) {
    throw new TypeError('Ubuntu capsule source inventory is invalid');
  }
  const objects = objectMap(descriptor);
  const used = new Set();
  const identities = new Set();
  const packages = value.packages.map((rawPackage, index) => {
    const item = exactObject(rawPackage, new Set(['package', 'version', 'directory', 'dsc', 'files']), `Ubuntu capsule source ${index}`);
    const name = packageName(item.package, `Ubuntu capsule source ${index}.package`);
    const version = packageVersion(item.version, `Ubuntu capsule source ${index}.version`);
    const identity = `${name}\0${version}`;
    if (identities.has(identity)) throw new TypeError('Ubuntu capsule source package identities must be unique');
    identities.add(identity);
    const directory = archivePath(item.directory, `Ubuntu capsule source ${index}.directory`);
    // The normalized descriptor owns the object bound; this package also
    // needs its distinct .dsc. Exact global claims below prevent reuse/extras.
    if (!Array.isArray(item.files) || item.files.length < 1 || item.files.length + 1 > objects.size) {
      throw new TypeError(`Ubuntu capsule source ${index}.files is invalid`);
    }
    const dsc = normalizeSourceFile(item.dsc, {
      context: `Ubuntu capsule source ${index}.dsc`, directory, objects, used, suffix: '.dsc',
    });
    const fileNames = new Set();
    const files = item.files.map((file, fileIndex) => {
      const normalized = normalizeSourceFile(file, {
        context: `Ubuntu capsule source ${index}.files[${fileIndex}]`, directory, objects, used,
      });
      if (fileNames.has(normalized.filename) || normalized.filename === dsc.filename) {
        throw new TypeError(`Ubuntu capsule source ${index} filenames must be unique`);
      }
      fileNames.add(normalized.filename);
      return normalized;
    }).sort((left, right) => compareText(left.filename, right.filename));
    return Object.freeze({ package: name, version, directory, dsc, files: Object.freeze(files) });
  }).sort((left, right) => compareText(left.package, right.package) || compareText(left.version, right.version));
  requireExactCoverage(descriptor, used, 'Ubuntu capsule source');
  const binarySources = new Set(binaries.packages.map((item) => `${item.source}\0${item.sourceVersion}`));
  const sourceIdentities = new Set(packages.map((item) => `${item.package}\0${item.version}`));
  if (binarySources.size !== sourceIdentities.size || [...binarySources].some((identity) => !sourceIdentities.has(identity))) {
    throw new TypeError('Ubuntu capsule source inventory does not exactly cover binary source mappings');
  }
  return Object.freeze({
    descriptor,
    descriptorSha256: immutableObjectSetDigest(descriptor),
    packages: Object.freeze(packages),
    inventorySha256: semanticDigest(packages),
  });
}

function normalizeRelease(raw) {
  const value = exactObject(
    raw,
    new Set(['distribution', 'release', 'codename', 'architecture', 'snapshot', 'baseMediaSha256', 'releaseId', 'sequence', 'upstreamKeyFingerprint', 'transaction', 'metadata', 'binaries', 'sources']),
    'Ubuntu package capsule release',
  );
  if (value.distribution !== UBUNTU_PACKAGE_CAPSULE_DISTRIBUTION) fail('Ubuntu package capsule distribution is unsupported');
  if (typeof value.release !== 'string' || !RELEASE.test(value.release)) throw new TypeError('Ubuntu package capsule release is invalid');
  if (typeof value.codename !== 'string' || !CODENAME.test(value.codename)) throw new TypeError('Ubuntu package capsule codename is invalid');
  if (typeof value.architecture !== 'string' || !ARCHITECTURE.test(value.architecture)) throw new TypeError('Ubuntu package capsule architecture is invalid');
  if (typeof value.snapshot !== 'string' || !SNAPSHOT.test(value.snapshot)) throw new TypeError('Ubuntu package capsule snapshot is invalid');
  const releaseId = safeId(value.releaseId, 'Ubuntu package capsule release identity');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new TypeError('Ubuntu package capsule release sequence is invalid');
  if (typeof value.upstreamKeyFingerprint !== 'string' || !FINGERPRINT.test(value.upstreamKeyFingerprint)) {
    throw new TypeError('Ubuntu package capsule upstream key fingerprint is invalid');
  }
  const transaction = normalizeTransaction(value.transaction);
  const metadata = normalizeMetadata(value.metadata, { releaseId, codename: value.codename, architecture: value.architecture });
  const binaries = normalizeBinaries(value.binaries, { releaseId, architecture: value.architecture, transaction });
  const sources = normalizeSources(value.sources, { releaseId, binaries });
  return Object.freeze({
    distribution: UBUNTU_PACKAGE_CAPSULE_DISTRIBUTION,
    release: value.release,
    codename: value.codename,
    architecture: value.architecture,
    snapshot: value.snapshot,
    baseMediaSha256: exactDigest(value.baseMediaSha256, 'Ubuntu package capsule base-media digest'),
    releaseId,
    sequence: value.sequence,
    upstreamKeyFingerprint: value.upstreamKeyFingerprint,
    transaction,
    transactionSha256: semanticDigest(transaction),
    metadata,
    binaries,
    sources,
  });
}

function payloadForNormalizedRelease(release) {
  return Buffer.from(JSON.stringify({
    protocol: UBUNTU_PACKAGE_CAPSULE_RELEASE_PROTOCOL,
    distribution: release.distribution,
    release: release.release,
    codename: release.codename,
    architecture: release.architecture,
    snapshot: release.snapshot,
    baseMediaSha256: release.baseMediaSha256,
    releaseId: release.releaseId,
    sequence: release.sequence,
    upstreamKeyFingerprint: release.upstreamKeyFingerprint,
    transactionSha256: release.transactionSha256,
    metadataDescriptorSha256: release.metadata.descriptorSha256,
    metadataInventorySha256: release.metadata.inventorySha256,
    binaryDescriptorSha256: release.binaries.descriptorSha256,
    binaryInventorySha256: release.binaries.inventorySha256,
    sourceDescriptorSha256: release.sources.descriptorSha256,
    sourceInventorySha256: release.sources.inventorySha256,
  }), 'utf8');
}

export function ubuntuPackageCapsuleReleasePayload(raw) {
  return payloadForNormalizedRelease(normalizeRelease(raw));
}

function normalizeSignature(raw) {
  const value = exactObject(raw, new Set(['algorithm', 'keyId', 'value']), 'Ubuntu package capsule signature');
  if (value.algorithm !== 'ed25519') fail('Ubuntu package capsule signature algorithm must be ed25519');
  if (typeof value.keyId !== 'string' || value.keyId.length > 128 || !KEY_ID.test(value.keyId)) {
    fail('Ubuntu package capsule signature key identity is invalid');
  }
  if (typeof value.value !== 'string' || value.value.length < 1 || value.value.length > 4096
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.value)) {
    fail('Ubuntu package capsule signature value is invalid');
  }
  const bytes = Buffer.from(value.value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value.value) fail('Ubuntu package capsule Ed25519 signature is invalid');
  return Object.freeze({ keyId: value.keyId, bytes });
}

export function verifyUbuntuPackageCapsuleReleaseInput(raw) {
  const input = exactObject(
    raw,
    new Set(['manifestBytes', 'publicKeyBytes', 'expectedManifestSha256', 'expectedPublicKeySha256', 'expectedKeyId']),
    'Ubuntu package capsule authority',
  );
  const manifestBytes = boundedBytes(input.manifestBytes, 'Ubuntu package capsule manifest', MAX_MANIFEST_BYTES);
  const publicKeyBytes = boundedBytes(input.publicKeyBytes, 'Ubuntu package capsule public key', MAX_KEY_BYTES);
  const expectedManifestSha256 = exactDigest(input.expectedManifestSha256, 'Ubuntu package capsule expected manifest digest');
  const expectedPublicKeySha256 = exactDigest(input.expectedPublicKeySha256, 'Ubuntu package capsule expected public-key digest');
  if (sha256(manifestBytes) !== expectedManifestSha256) fail('Ubuntu package capsule manifest digest does not match authority');
  if (sha256(publicKeyBytes) !== expectedPublicKeySha256) fail('Ubuntu package capsule public-key digest does not match authority');
  if (typeof input.expectedKeyId !== 'string' || input.expectedKeyId.length > 128 || !KEY_ID.test(input.expectedKeyId)) {
    throw new TypeError('Ubuntu package capsule expected key identity is invalid');
  }
  let parsed;
  try { parsed = JSON.parse(manifestBytes.toString('utf8')); }
  catch { fail('Ubuntu package capsule manifest is not valid JSON'); }
  const manifest = exactObject(parsed, new Set(['protocol', 'release', 'signature']), 'Ubuntu package capsule manifest');
  if (manifest.protocol !== UBUNTU_PACKAGE_CAPSULE_MANIFEST_PROTOCOL) fail('Ubuntu package capsule manifest protocol is unsupported');
  const release = normalizeRelease(manifest.release);
  const signature = normalizeSignature(manifest.signature);
  if (signature.keyId !== input.expectedKeyId) fail('Ubuntu package capsule signature key identity does not match authority');
  let publicKey;
  try { publicKey = createPublicKey(publicKeyBytes); }
  catch { fail('Ubuntu package capsule public key could not be parsed'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('Ubuntu package capsule public key must be Ed25519');
  if (!verifySignature(null, payloadForNormalizedRelease(release), publicKey, signature.bytes)) {
    fail('Ubuntu package capsule signature verification failed');
  }
  return Object.freeze({
    ...release,
    manifestSha256: expectedManifestSha256,
    publicKeySha256: expectedPublicKeySha256,
    keyId: signature.keyId,
  });
}
