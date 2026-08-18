import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const POLICY_PROTOCOL = 'patch-poller/release-policy-v1';
const MANIFEST_PROTOCOL = 'patch-poller/release-manifest-v1';
const SHA_RE = /^[0-9a-f]{40}$/u;
const KEY_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const SAFE_MANIFEST_RE = /^[A-Za-z0-9_.\/-]{1,240}$/u;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function realRegularFile(filePath, label) {
  const info = lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a real regular file`);
  return filePath;
}

function parseJsonFile(filePath, label) {
  let value;
  try { value = JSON.parse(readFileSync(filePath, 'utf8')); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must contain an object`);
  return value;
}

function safeManifestPath(candidateDir, relative) {
  if (typeof relative !== 'string' || !SAFE_MANIFEST_RE.test(relative) || path.isAbsolute(relative) || relative.includes('..')) {
    throw new Error('release policy manifestPath must be a safe candidate-relative path');
  }
  const root = path.resolve(candidateDir);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('release manifest escaped candidate runtime');
  return target;
}

function canonicalReleasePayload(manifest) {
  return Buffer.from(JSON.stringify({
    protocol: MANIFEST_PROTOCOL,
    commit: manifest.commit,
    tree: manifest.tree,
    issuedAt: manifest.issuedAt,
    keyId: manifest.keyId,
  }), 'utf8');
}

export function defaultReleasePolicyPath(paths, environment = process.env) {
  const configured = environment.PATCH_POLLER_RELEASE_POLICY;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('PATCH_POLLER_RELEASE_POLICY must be an absolute local path');
    return path.resolve(configured);
  }
  return path.join(path.resolve(paths.home), 'release-policy.json');
}

export function loadBootstrapReleasePolicy({ channel, paths, environment = process.env } = {}) {
  const policyPath = defaultReleasePolicyPath(paths, environment);
  if (!existsSync(policyPath)) {
    if (channel === 'testing') {
      return {
        protocol: POLICY_PROTOCOL,
        mode: 'development',
        source: 'testing-default',
        policyPath: null,
        manifestPath: 'release/patch-poller-release.json',
        keyId: null,
        publicKeyFile: null,
      };
    }
    throw new Error(`stable runtime updates require a local production release policy at ${policyPath}`);
  }

  realRegularFile(policyPath, 'release policy');
  const value = parseJsonFile(policyPath, 'release policy');
  if (value.protocol !== POLICY_PROTOCOL) throw new Error('release policy protocol is unsupported');
  if (!['development', 'production'].includes(value.mode)) throw new Error('release policy mode must be development or production');
  if (value.mode === 'development' && channel !== 'testing') throw new Error('development release policy is permitted only for the testing channel');

  const manifestPath = value.manifestPath ?? 'release/patch-poller-release.json';
  if (typeof manifestPath !== 'string' || !SAFE_MANIFEST_RE.test(manifestPath) || path.isAbsolute(manifestPath) || manifestPath.includes('..')) {
    throw new Error('release policy manifestPath is invalid');
  }

  if (value.mode === 'development') {
    return { protocol: POLICY_PROTOCOL, mode: 'development', source: 'local-policy', policyPath, manifestPath, keyId: null, publicKeyFile: null };
  }
  if (!KEY_ID_RE.test(value.keyId ?? '')) throw new Error('production release policy keyId is invalid');
  if (typeof value.publicKeyFile !== 'string' || !path.isAbsolute(value.publicKeyFile)) throw new Error('production release policy publicKeyFile must be an absolute local path');
  const publicKeyFile = realRegularFile(path.resolve(value.publicKeyFile), 'release public key');
  return {
    protocol: POLICY_PROTOCOL,
    mode: 'production',
    source: 'local-policy',
    policyPath,
    manifestPath,
    keyId: value.keyId,
    publicKeyFile,
  };
}

export function verifyRuntimeRelease({ candidateDir, commitSha, treeSha, policy }) {
  if (!SHA_RE.test(String(commitSha))) throw new Error('candidate release commit must be an exact lowercase 40-hex SHA');
  if (!SHA_RE.test(String(treeSha))) throw new Error('candidate release tree must be an exact lowercase 40-hex SHA');
  if (!policy || policy.protocol !== POLICY_PROTOCOL) throw new Error('candidate release policy is missing or invalid');
  if (policy.mode === 'development') {
    return {
      protocol: 'patch-poller/release-verification-v1',
      mode: 'development',
      verified: false,
      commit: commitSha,
      tree: treeSha,
      keyId: null,
      manifestDigest: null,
      reason: 'mutable-testing-channel',
    };
  }
  if (policy.mode !== 'production') throw new Error('candidate release policy mode is unsupported');

  const manifestFile = safeManifestPath(candidateDir, policy.manifestPath);
  realRegularFile(manifestFile, 'release manifest');
  const raw = readFileSync(manifestFile);
  if (raw.length > 64 * 1024) throw new Error('release manifest exceeds its bounded size');
  const manifest = parseJsonFile(manifestFile, 'release manifest');
  const allowed = new Set(['protocol', 'commit', 'tree', 'issuedAt', 'keyId', 'signature']);
  if (Object.keys(manifest).some((key) => !allowed.has(key))) throw new Error('release manifest contains unsupported fields');
  if (manifest.protocol !== MANIFEST_PROTOCOL) throw new Error('release manifest protocol is unsupported');
  if (manifest.commit !== commitSha) throw new Error('release manifest commit does not match candidate commit');
  if (manifest.tree !== treeSha) throw new Error('release manifest tree does not match candidate tree');
  if (manifest.keyId !== policy.keyId) throw new Error('release manifest keyId does not match local release policy');
  if (typeof manifest.issuedAt !== 'string' || !Number.isFinite(Date.parse(manifest.issuedAt))) throw new Error('release manifest issuedAt is invalid');
  if (typeof manifest.signature !== 'string' || manifest.signature.length < 40 || manifest.signature.length > 1024 || !/^[A-Za-z0-9+/=]+$/u.test(manifest.signature)) {
    throw new Error('release manifest signature is invalid');
  }

  const publicKey = createPublicKey(readFileSync(policy.publicKeyFile));
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('release public key must be Ed25519');
  const signature = Buffer.from(manifest.signature, 'base64');
  const payload = canonicalReleasePayload(manifest);
  if (!verify(null, payload, publicKey, signature)) throw new Error('release manifest signature verification failed');

  return {
    protocol: 'patch-poller/release-verification-v1',
    mode: 'production',
    verified: true,
    commit: commitSha,
    tree: treeSha,
    keyId: manifest.keyId,
    issuedAt: manifest.issuedAt,
    manifestDigest: sha256(raw),
    signedPayloadDigest: sha256(payload),
    reason: null,
  };
}

export function releaseManifestPayload(value) {
  if (!value || typeof value !== 'object') throw new TypeError('release manifest payload requires an object');
  return canonicalReleasePayload(value);
}
