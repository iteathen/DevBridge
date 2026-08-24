import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/ubuntu-release-media-v1';
const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE = /^[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?$/u;
const ARCHITECTURE = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/u;
const DEFAULT_ALLOWED_HOSTS = Object.freeze(['releases.ubuntu.com', 'cdimage.ubuntu.com']);

async function regularFile(location, label) {
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real regular file`);
  return info;
}

async function sha256File(location) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(location);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function checkedUrl(value, allowedHosts, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(`${label} URL is invalid`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new Error(`${label} URL is not an approved HTTPS source`);
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) throw new Error(`${label} URL host is not approved`);
  if (parsed.hash) throw new Error(`${label} URL fragment is not allowed`);
  return parsed;
}

function validateAuthority(value, allowedHosts) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== PROTOCOL) throw new Error('release media authority is invalid');
  const allowed = new Set(['protocol', 'release', 'architecture', 'media', 'checksums']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`release media authority field is not allowed: ${key}`);
  if (typeof value.release !== 'string' || !RELEASE.test(value.release)) throw new Error('release identity is invalid');
  if (typeof value.architecture !== 'string' || !ARCHITECTURE.test(value.architecture)) throw new Error('release architecture is invalid');
  if (!value.media || typeof value.media !== 'object' || Array.isArray(value.media)) throw new Error('release media identity is invalid');
  if (!value.checksums || typeof value.checksums !== 'object' || Array.isArray(value.checksums)) throw new Error('release checksum identity is invalid');
  for (const key of Object.keys(value.media)) if (!['url', 'name', 'sha256', 'bytes'].includes(key)) throw new Error(`release media field is not allowed: ${key}`);
  for (const key of Object.keys(value.checksums)) if (!['manifestUrl', 'signatureUrl', 'signerFingerprint'].includes(key)) throw new Error(`release checksum field is not allowed: ${key}`);
  if (typeof value.media.name !== 'string' || !FILE_NAME.test(value.media.name) || path.basename(value.media.name) !== value.media.name) throw new Error('release media name is invalid');
  if (typeof value.media.sha256 !== 'string' || !SHA256.test(value.media.sha256)) throw new Error('release media digest is invalid');
  if (!Number.isSafeInteger(value.media.bytes) || value.media.bytes < 1) throw new Error('release media byte count is invalid');
  if (typeof value.checksums.signerFingerprint !== 'string' || !FINGERPRINT.test(value.checksums.signerFingerprint)) throw new Error('release checksum signer identity is invalid');
  checkedUrl(value.media.url, allowedHosts, 'release media');
  checkedUrl(value.checksums.manifestUrl, allowedHosts, 'checksum manifest');
  checkedUrl(value.checksums.signatureUrl, allowedHosts, 'checksum signature');
  return structuredClone(value);
}

function digestFromManifest(text, fileName) {
  let match = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    const parsed = /^([a-fA-F0-9]{64})[ \t]+[* ]?([^\s].*)$/u.exec(line);
    if (!parsed) continue;
    const candidate = parsed[2].trim();
    if (candidate === fileName) {
      if (match !== null) throw new Error('checksum manifest contains duplicate media entries');
      match = parsed[1].toLowerCase();
    }
  }
  if (match === null) throw new Error('checksum manifest does not contain the approved media name');
  return match;
}

async function ensureDestination(directory) {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('release media destination must be a real directory');
}

async function ensureCache(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('release media cache must be a real directory');
}

async function acquire(download, url, destination, allowedHosts, label, extra = {}) {
  const result = await download({ url, destination, ...extra });
  if (!result || typeof result.finalUrl !== 'string') throw new Error(`${label} download did not report its final source URL`);
  checkedUrl(result.finalUrl, allowedHosts, `${label} final source`);
  await regularFile(destination, label);
}

async function exactCachedMedia(location, expected) {
  try {
    const info = await regularFile(location, 'cached release media');
    if (info.size !== expected.bytes || await sha256File(location) !== expected.sha256) {
      await rm(location, { force: true });
      await rm(`${location}.partial`, { force: true });
      return false;
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export class UbuntuReleaseMediaSource {
  #authorityLookup;
  #download;
  #verifyManifest;
  #allowedHosts;
  #mediaCacheDirectory;

  constructor({ authorityLookup, download, verifyManifest, allowedHosts = DEFAULT_ALLOWED_HOSTS, mediaCacheDirectory = null } = {}) {
    if (typeof authorityLookup !== 'function') throw new TypeError('authorityLookup must be a function');
    if (typeof download !== 'function') throw new TypeError('download must be a function');
    if (typeof verifyManifest !== 'function') throw new TypeError('verifyManifest must be a function');
    if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || allowedHosts.some((host) => typeof host !== 'string' || host.length === 0)) throw new TypeError('allowedHosts is invalid');
    if (mediaCacheDirectory != null && (typeof mediaCacheDirectory !== 'string' || mediaCacheDirectory.length === 0 || mediaCacheDirectory.includes('\0') || !path.isAbsolute(mediaCacheDirectory))) throw new TypeError('mediaCacheDirectory must be an absolute local path');
    this.#authorityLookup = authorityLookup;
    this.#download = download;
    this.#verifyManifest = verifyManifest;
    this.#allowedHosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
    this.#mediaCacheDirectory = mediaCacheDirectory == null ? null : path.resolve(mediaCacheDirectory);
  }

  async acquire({ authorityRef, destination }) {
    if (typeof authorityRef !== 'string' || !SUBJECT.test(authorityRef)) throw new TypeError('release media authority reference is invalid');
    if (typeof destination !== 'string' || destination.length === 0) throw new TypeError('release media destination is invalid');
    const authority = validateAuthority(await this.#authorityLookup(authorityRef), this.#allowedHosts);
    await ensureDestination(destination);

    try {
      const manifestLocation = path.join(destination, 'SHA256SUMS');
      const signatureLocation = path.join(destination, 'SHA256SUMS.gpg');
      await acquire(this.#download, authority.checksums.manifestUrl, manifestLocation, this.#allowedHosts, 'checksum manifest');
      await acquire(this.#download, authority.checksums.signatureUrl, signatureLocation, this.#allowedHosts, 'checksum signature');

      const manifestDigestBeforeVerification = await sha256File(manifestLocation);
      const verification = await this.#verifyManifest({
        manifest: manifestLocation,
        signature: signatureLocation,
        expectedFingerprint: authority.checksums.signerFingerprint,
      });
      if (
        !verification
        || verification.verified !== true
        || verification.signerFingerprint !== authority.checksums.signerFingerprint
        || verification.manifestSha256 !== manifestDigestBeforeVerification
      ) {
        throw new Error('release checksum signature verification failed');
      }

      const manifestDigest = await sha256File(manifestLocation);
      if (manifestDigest !== manifestDigestBeforeVerification) throw new Error('release checksum manifest changed after signature verification');
      const manifestText = await readFile(manifestLocation, 'utf8');
      if (digestFromManifest(manifestText, authority.media.name) !== authority.media.sha256) throw new Error('approved media digest does not match signed checksum manifest');

      let mediaLocation = path.join(destination, authority.media.name);
      if (this.#mediaCacheDirectory != null) {
        await ensureCache(this.#mediaCacheDirectory);
        mediaLocation = path.join(this.#mediaCacheDirectory, `${authority.media.sha256}.iso`);
      }
      if (!await exactCachedMedia(mediaLocation, authority.media)) {
        await acquire(
          this.#download,
          authority.media.url,
          mediaLocation,
          this.#allowedHosts,
          'release media',
          { resume: { bytes: authority.media.bytes, sha256: authority.media.sha256 } },
        );
      }
      const info = await regularFile(mediaLocation, 'release media');
      if (info.size !== authority.media.bytes) throw new Error('release media byte count does not match authority');
      if (await sha256File(mediaLocation) !== authority.media.sha256) throw new Error('release media digest does not match authority');

      return {
        location: mediaLocation,
        identity: {
          protocol: PROTOCOL,
          release: authority.release,
          architecture: authority.architecture,
          name: authority.media.name,
          bytes: authority.media.bytes,
          sha256: authority.media.sha256,
          checksumManifestSha256: manifestDigest,
          checksumSignerFingerprint: authority.checksums.signerFingerprint,
        },
      };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
}

export function createUbuntuReleaseMediaSource(options) {
  return new UbuntuReleaseMediaSource(options);
}
