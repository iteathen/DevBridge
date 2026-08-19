import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_MANIFEST_PROTOCOL = 'patch-poller/release-manifest-v1';
export const RELEASE_SUBJECT_PROTOCOL = 'patch-poller/release-subject-v1';
export const RELEASE_REPOSITORY = 'iteathen/PATCH-POLLER';

const HEAD_RE = /^[0-9a-f]{40}$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const MAX_ARTIFACT_FILES = 100_000;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

function fail(message) { throw new Error(message); }

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('release manifest release subject must be an object');
  const allowed = new Set(['repository', 'head', 'artifactSha256', 'version']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`release manifest field release.${key} is unsupported`);
  if (value.repository !== RELEASE_REPOSITORY) fail(`release manifest repository must be ${RELEASE_REPOSITORY}`);
  const head = String(value.head ?? '').toLowerCase();
  const artifactSha256 = String(value.artifactSha256 ?? '').toLowerCase();
  if (!HEAD_RE.test(head)) fail('release manifest head must be an exact 40-hex Git commit SHA');
  if (!DIGEST_RE.test(artifactSha256)) fail('release manifest artifactSha256 must be an exact SHA-256 digest');
  if (typeof value.version !== 'string' || value.version.length === 0 || value.version.length > 128) {
    fail('release manifest version must be a bounded non-empty string');
  }
  return { repository: RELEASE_REPOSITORY, head, artifactSha256, version: value.version };
}

export function releaseSubjectPayload(release) {
  const normalized = normalizeRelease(release);
  return Buffer.from(JSON.stringify({
    protocol: RELEASE_SUBJECT_PROTOCOL,
    repository: normalized.repository,
    head: normalized.head,
    artifactSha256: normalized.artifactSha256,
    version: normalized.version,
  }), 'utf8');
}

function normalizeSignature(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('release manifest signature must be an object');
  const allowed = new Set(['algorithm', 'keyId', 'value']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`release manifest field signature.${key} is unsupported`);
  if (value.algorithm !== 'ed25519') fail('release manifest signature algorithm must be ed25519');
  if (typeof value.keyId !== 'string' || value.keyId.length === 0 || value.keyId.length > 128 || !/^[A-Za-z0-9_.:-]+$/u.test(value.keyId)) {
    fail('release manifest signature keyId is invalid');
  }
  if (typeof value.value !== 'string' || value.value.length === 0 || value.value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.value)) {
    fail('release manifest signature value must be bounded base64');
  }
  const bytes = Buffer.from(value.value, 'base64');
  if (bytes.length !== 64) fail('release manifest Ed25519 signature must be exactly 64 bytes');
  return { algorithm: 'ed25519', keyId: value.keyId, value: value.value, bytes };
}

export async function readSignedReleaseManifest(manifestPath, publicKeyPath) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) fail('production release mode requires a local release manifest path');
  if (typeof publicKeyPath !== 'string' || publicKeyPath.length === 0) fail('production release mode requires a local release public-key path');
  const manifestFile = path.resolve(manifestPath);
  const publicKeyFile = path.resolve(publicKeyPath);
  const manifestBytes = await readFile(manifestFile);
  if (manifestBytes.length === 0 || manifestBytes.length > MAX_MANIFEST_BYTES) fail('release manifest is empty or exceeds the bounded manifest size');
  let parsed;
  try { parsed = JSON.parse(manifestBytes.toString('utf8')); }
  catch { fail('release manifest is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('release manifest must be an object');
  const allowed = new Set(['protocol', 'release', 'signature']);
  for (const key of Object.keys(parsed)) if (!allowed.has(key)) fail(`release manifest field ${key} is unsupported`);
  if (parsed.protocol !== RELEASE_MANIFEST_PROTOCOL) fail('unsupported release manifest protocol');

  const release = normalizeRelease(parsed.release);
  const signature = normalizeSignature(parsed.signature);
  const publicKeyBytes = await readFile(publicKeyFile);
  let publicKey;
  try { publicKey = createPublicKey(publicKeyBytes); }
  catch { fail('release public key could not be parsed'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('release public key must be Ed25519');
  if (!verifySignature(null, releaseSubjectPayload(release), publicKey, signature.bytes)) {
    fail('release manifest signature verification failed');
  }

  return {
    protocol: RELEASE_MANIFEST_PROTOCOL,
    release,
    signature: { algorithm: signature.algorithm, keyId: signature.keyId },
    manifestSha256: sha256(manifestBytes),
    manifestPath: manifestFile,
    publicKeyPath: publicKeyFile,
  };
}

function appendField(hash, name, value) {
  const nameBytes = Buffer.from(String(name), 'utf8');
  const valueBytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(nameBytes.length, 0);
  header.writeUInt32BE(valueBytes.length, 4);
  hash.update(header);
  hash.update(nameBytes);
  hash.update(valueBytes);
}

export async function runtimeArtifactSha256(runtimeDir, {
  maxFiles = MAX_ARTIFACT_FILES,
  maxBytes = MAX_ARTIFACT_BYTES,
} = {}) {
  const root = path.resolve(runtimeDir);
  const hash = createHash('sha256');
  appendField(hash, 'protocol', 'patch-poller/runtime-artifact-v1');
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (prefix === '' && entry.name === '.git') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        appendField(hash, 'directory', relative);
        await walk(absolute, relative);
        continue;
      }
      fileCount += 1;
      if (fileCount > maxFiles) fail(`runtime artifact exceeds ${maxFiles} files`);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        totalBytes += Buffer.byteLength(target, 'utf8');
        if (totalBytes > maxBytes) fail(`runtime artifact exceeds ${maxBytes} bytes`);
        appendField(hash, 'symlink-path', relative);
        appendField(hash, 'symlink-target', target);
        continue;
      }
      if (!info.isFile()) fail(`runtime artifact contains unsupported filesystem object: ${relative}`);
      const bytes = await readFile(absolute);
      totalBytes += bytes.length;
      if (totalBytes > maxBytes) fail(`runtime artifact exceeds ${maxBytes} bytes`);
      appendField(hash, 'file-path', relative);
      appendField(hash, 'file-bytes', bytes);
    }
  }

  await walk(root);
  return {
    protocol: 'patch-poller/runtime-artifact-v1',
    sha256: hash.digest('hex'),
    fileCount,
    totalBytes,
  };
}

export async function verifyRuntimeReleaseIntegrity({ args, runtime, manifest = null }) {
  const artifact = await runtimeArtifactSha256(runtime.runtimeDir);
  if (args.releaseMode !== 'production') {
    return {
      mode: 'development',
      verified: false,
      immutableRelease: false,
      artifactSha256: artifact.sha256,
      artifactFileCount: artifact.fileCount,
      artifactBytes: artifact.totalBytes,
      manifestSha256: null,
      keyId: null,
    };
  }

  const signed = manifest ?? await readSignedReleaseManifest(args.releaseManifest, args.releasePublicKey);
  if (runtime.head.toLowerCase() !== signed.release.head) {
    fail(`runtime head ${runtime.head} does not match signed release head ${signed.release.head}`);
  }
  if (runtime.version !== signed.release.version) {
    fail(`runtime version ${runtime.version} does not match signed release version ${signed.release.version}`);
  }
  if (artifact.sha256 !== signed.release.artifactSha256) {
    fail(`runtime artifact SHA-256 ${artifact.sha256} does not match signed release artifact ${signed.release.artifactSha256}`);
  }
  return {
    mode: 'production',
    verified: true,
    immutableRelease: true,
    artifactSha256: artifact.sha256,
    artifactFileCount: artifact.fileCount,
    artifactBytes: artifact.totalBytes,
    manifestSha256: signed.manifestSha256,
    keyId: signed.signature.keyId,
    releaseHead: signed.release.head,
  };
}
