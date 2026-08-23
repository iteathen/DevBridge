import { createHash } from 'node:crypto';
import path from 'node:path';

export const UBUNTU_RELEASE_MEDIA_AUTHORITY_PROTOCOL = 'devbridge/ubuntu-release-media-v1';
export const DEFAULT_UBUNTU_RELEASE_MEDIA_HOSTS = Object.freeze(['releases.ubuntu.com', 'cdimage.ubuntu.com']);

const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE = /^[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?$/u;
const ARCHITECTURE = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/u;
const MAX_AUTHORITY_BYTES = 256 * 1024;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function normalizeHosts(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) throw new TypeError('release media allowed hosts are invalid');
  const hosts = new Set();
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 253) throw new TypeError('release media allowed host is invalid');
    const host = entry.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host) || host.includes('..')) throw new TypeError('release media allowed host is invalid');
    hosts.add(host);
  }
  if (hosts.size !== raw.length) throw new TypeError('release media allowed hosts contain duplicates');
  return hosts;
}

export function normalizeUbuntuReleaseMediaAllowedHosts(raw = DEFAULT_UBUNTU_RELEASE_MEDIA_HOSTS) {
  return normalizeHosts(raw);
}

export function requireUbuntuReleaseMediaUrl(value, allowedHosts = DEFAULT_UBUNTU_RELEASE_MEDIA_HOSTS, label = 'release media') {
  const hosts = allowedHosts instanceof Set ? allowedHosts : normalizeHosts(allowedHosts);
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(`${label} URL is invalid`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) throw new Error(`${label} URL is not an approved HTTPS source`);
  if (!hosts.has(parsed.hostname.toLowerCase())) throw new Error(`${label} URL host is not approved`);
  return parsed.toString();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function contentDigest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

export function normalizeUbuntuReleaseMediaAuthority(raw, { allowedHosts = DEFAULT_UBUNTU_RELEASE_MEDIA_HOSTS } = {}) {
  const hosts = allowedHosts instanceof Set ? allowedHosts : normalizeHosts(allowedHosts);
  const value = onlyKeys(raw, new Set(['protocol', 'release', 'architecture', 'media', 'checksums']), 'release media authority');
  if (value.protocol !== UBUNTU_RELEASE_MEDIA_AUTHORITY_PROTOCOL) throw new TypeError('release media authority protocol is unsupported');
  if (typeof value.release !== 'string' || !RELEASE.test(value.release)) throw new TypeError('release media release is invalid');
  if (typeof value.architecture !== 'string' || !ARCHITECTURE.test(value.architecture)) throw new TypeError('release media architecture is invalid');

  const media = onlyKeys(value.media, new Set(['url', 'name', 'sha256', 'bytes']), 'release media authority.media');
  if (typeof media.name !== 'string' || !FILE_NAME.test(media.name) || path.basename(media.name) !== media.name) throw new TypeError('release media name is invalid');
  if (typeof media.sha256 !== 'string' || !SHA256.test(media.sha256)) throw new TypeError('release media digest is invalid');
  if (!Number.isSafeInteger(media.bytes) || media.bytes < 1) throw new TypeError('release media byte count is invalid');

  const checksums = onlyKeys(value.checksums, new Set(['manifestUrl', 'signatureUrl', 'signerFingerprint']), 'release media authority.checksums');
  if (typeof checksums.signerFingerprint !== 'string' || !FINGERPRINT.test(checksums.signerFingerprint)) throw new TypeError('release media signer fingerprint is invalid');

  const normalized = Object.freeze({
    protocol: UBUNTU_RELEASE_MEDIA_AUTHORITY_PROTOCOL,
    release: value.release,
    architecture: value.architecture,
    media: Object.freeze({
      url: requireUbuntuReleaseMediaUrl(media.url, hosts, 'release media'),
      name: media.name,
      sha256: media.sha256,
      bytes: media.bytes,
    }),
    checksums: Object.freeze({
      manifestUrl: requireUbuntuReleaseMediaUrl(checksums.manifestUrl, hosts, 'checksum manifest'),
      signatureUrl: requireUbuntuReleaseMediaUrl(checksums.signatureUrl, hosts, 'checksum signature'),
      signerFingerprint: checksums.signerFingerprint,
    }),
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_AUTHORITY_BYTES) throw new TypeError('release media authority is too large');
  return normalized;
}

export function ubuntuReleaseMediaAuthoritySubject(raw, options) {
  const authority = normalizeUbuntuReleaseMediaAuthority(raw, options);
  return `subject-${contentDigest(authority).slice(0, 32)}`;
}

export function requireUbuntuReleaseMediaAuthoritySubject(value) {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError('release media authority reference is invalid');
  return value;
}
