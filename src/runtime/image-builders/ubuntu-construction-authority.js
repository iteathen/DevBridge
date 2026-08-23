import { createHash } from 'node:crypto';

export const UBUNTU_CONSTRUCTION_AUTHORITY_PROTOCOL = 'devbridge/ubuntu-construction-authority-v1';

const SOURCE_PROTOCOL = 'devbridge/ubuntu-release-media-v1';
const RECIPE_PROTOCOL = 'devbridge/ubuntu-autoinstall-recipe-v1';
const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/u;
const RELEASE = /^[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{0,79}$/u;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,159}$/u;
const PATCH_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const MUTABLE_VERSION = /^(?:latest|stable|current|head|main|master)$/iu;
const APPROVED_SOURCE_HOSTS = new Set(['releases.ubuntu.com', 'cdimage.ubuntu.com']);
const MAX_PATCH_BYTES = 64 * 1024;
const MAX_AUTHORITY_BYTES = 4 * 1024 * 1024;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function sha256(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function approvedUrl(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(`${name} is invalid`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) throw new TypeError(`${name} is invalid`);
  if (!APPROVED_SOURCE_HOSTS.has(parsed.hostname.toLowerCase())) throw new TypeError(`${name} host is not approved`);
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

function normalizeSource(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'release', 'architecture', 'media', 'checksums']), 'construction source');
  if (value.protocol !== SOURCE_PROTOCOL) throw new TypeError('construction source protocol is unsupported');
  if (typeof value.release !== 'string' || !RELEASE.test(value.release)) throw new TypeError('construction source release is invalid');
  const architecture = safeId(value.architecture, 'construction source architecture');
  const media = onlyKeys(value.media, new Set(['url', 'name', 'sha256', 'bytes']), 'construction source.media');
  const checksums = onlyKeys(value.checksums, new Set(['manifestUrl', 'signatureUrl', 'signerFingerprint']), 'construction source.checksums');
  if (typeof media.name !== 'string' || !FILE_NAME.test(media.name)) throw new TypeError('construction source media name is invalid');
  if (!Number.isSafeInteger(media.bytes) || media.bytes < 1) throw new TypeError('construction source media bytes is invalid');
  if (typeof checksums.signerFingerprint !== 'string' || !FINGERPRINT.test(checksums.signerFingerprint)) throw new TypeError('construction source signer fingerprint is invalid');
  return Object.freeze({
    protocol: SOURCE_PROTOCOL,
    release: value.release,
    architecture,
    media: Object.freeze({
      url: approvedUrl(media.url, 'construction source media URL'),
      name: media.name,
      sha256: sha256(media.sha256, 'construction source media sha256'),
      bytes: media.bytes,
    }),
    checksums: Object.freeze({
      manifestUrl: approvedUrl(checksums.manifestUrl, 'construction checksum manifest URL'),
      signatureUrl: approvedUrl(checksums.signatureUrl, 'construction checksum signature URL'),
      signerFingerprint: checksums.signerFingerprint,
    }),
  });
}

function normalizeRecipe(raw, expectedSourceSha256) {
  const value = onlyKeys(raw, new Set(['protocol', 'sourceSha256', 'patches', 'generation']), 'construction recipe');
  if (value.protocol !== RECIPE_PROTOCOL) throw new TypeError('construction recipe protocol is unsupported');
  const sourceSha256 = sha256(value.sourceSha256, 'construction recipe source sha256');
  if (sourceSha256 !== expectedSourceSha256) throw new TypeError('construction recipe source does not match construction media');
  const generation = safeId(value.generation, 'construction recipe generation');
  if (!Array.isArray(value.patches) || value.patches.length === 0 || value.patches.length > 32) throw new TypeError('construction recipe patches is invalid');
  const seen = new Set();
  const patches = value.patches.map((entry, index) => {
    const patch = onlyKeys(entry, new Set(['id', 'occurrences', 'before', 'after']), `construction recipe patch ${index}`);
    if (typeof patch.id !== 'string' || !PATCH_ID.test(patch.id) || seen.has(patch.id)) throw new TypeError(`construction recipe patch ${index}.id is invalid`);
    if (!Number.isSafeInteger(patch.occurrences) || patch.occurrences < 1 || patch.occurrences > 64) throw new TypeError(`construction recipe patch ${index}.occurrences is invalid`);
    if (typeof patch.before !== 'string' || typeof patch.after !== 'string') throw new TypeError(`construction recipe patch ${index} bytes are invalid`);
    const beforeBytes = Buffer.byteLength(patch.before, 'utf8');
    if (beforeBytes < 1 || beforeBytes > MAX_PATCH_BYTES || beforeBytes !== Buffer.byteLength(patch.after, 'utf8') || patch.before === patch.after) {
      throw new TypeError(`construction recipe patch ${index} replacement is invalid`);
    }
    seen.add(patch.id);
    return Object.freeze({ id: patch.id, occurrences: patch.occurrences, before: patch.before, after: patch.after });
  });
  return Object.freeze({ protocol: RECIPE_PROTOCOL, sourceSha256, generation, patches: Object.freeze(patches) });
}

function normalizePackages(raw) {
  const value = onlyKeys(raw, new Set(['generation', 'packages']), 'construction packages');
  const generation = safeId(value.generation, 'construction package generation');
  if (!Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > 64) throw new TypeError('construction package set is invalid');
  const seen = new Set();
  const packages = value.packages.map((entry, index) => {
    const item = onlyKeys(entry, new Set(['name', 'version']), `construction package ${index}`);
    if (typeof item.name !== 'string' || !PACKAGE_NAME.test(item.name) || seen.has(item.name)) throw new TypeError(`construction package ${index}.name is invalid`);
    if (typeof item.version !== 'string' || !PACKAGE_VERSION.test(item.version) || !/\d/u.test(item.version) || MUTABLE_VERSION.test(item.version)) throw new TypeError(`construction package ${index}.version is invalid`);
    seen.add(item.name);
    return Object.freeze({ name: item.name, version: item.version });
  });
  return Object.freeze({ generation, packages: Object.freeze(packages) });
}

function normalizePayload(raw) {
  const value = onlyKeys(raw, new Set(['generation']), 'construction payload');
  return Object.freeze({ generation: safeId(value.generation, 'construction payload generation') });
}

function normalizeQualification(raw = {}) {
  const value = onlyKeys(raw, new Set(['commands']), 'construction qualification');
  const source = value.commands ?? [];
  if (!Array.isArray(source) || source.length > 32) throw new TypeError('construction qualification commands is invalid');
  const seen = new Set();
  const commands = source.map((entry, index) => {
    if (typeof entry !== 'string' || !COMMAND.test(entry) || seen.has(entry)) throw new TypeError(`construction qualification command ${index} is invalid`);
    seen.add(entry);
    return entry;
  });
  return Object.freeze({ commands: Object.freeze(commands.sort()) });
}

function normalizeOutput(raw) {
  const value = onlyKeys(raw, new Set(['profile', 'generation', 'bootstrap']), 'construction output');
  return Object.freeze({
    profile: safeId(value.profile, 'construction output profile'),
    generation: safeId(value.generation, 'construction output generation'),
    bootstrap: safeId(value.bootstrap, 'construction output bootstrap'),
  });
}

export function normalizeUbuntuConstructionAuthority(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'source', 'recipe', 'packages', 'payload', 'qualification', 'output']), 'construction authority');
  if (value.protocol !== UBUNTU_CONSTRUCTION_AUTHORITY_PROTOCOL) throw new TypeError('construction authority protocol is unsupported');
  const source = normalizeSource(value.source);
  const normalized = Object.freeze({
    protocol: UBUNTU_CONSTRUCTION_AUTHORITY_PROTOCOL,
    source,
    recipe: normalizeRecipe(value.recipe, source.media.sha256),
    packages: normalizePackages(value.packages),
    payload: normalizePayload(value.payload),
    qualification: normalizeQualification(value.qualification),
    output: normalizeOutput(value.output),
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_AUTHORITY_BYTES) throw new TypeError('construction authority is too large');
  return normalized;
}

export function ubuntuConstructionAuthoritySubject(raw) {
  const authority = normalizeUbuntuConstructionAuthority(raw);
  return `subject-${contentDigest(authority).slice(0, 32)}`;
}

export function requireUbuntuConstructionAuthoritySubject(value) {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError('construction authority reference is invalid');
  return value;
}
