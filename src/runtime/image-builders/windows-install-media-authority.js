import { createHash } from 'node:crypto';

export const WINDOWS_INSTALL_MEDIA_AUTHORITY_PROTOCOL = 'devbridge/windows-install-media-authority-v1';

const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._()+ -]{0,159}\.iso$/iu;
const POLICY_REFERENCE = /^policy:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const EDITION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}$/u;
const VERSION = /^10\.0\.(\d{4,6})\.(\d{1,6})$/u;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const SOURCE_CLASSES = new Set(['official-owned', 'organization-approved', 'enterprise-offline', 'evaluation']);
const MAX_AUTHORITY_BYTES = 256 * 1024;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function sha256(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function boundedText(value, name, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, 'utf8') > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function microsoftReference(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('install media approval reference must be a Microsoft HTTPS source'); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !(host === 'microsoft.com' || host.endsWith('.microsoft.com'))) {
    throw new TypeError('install media approval reference must be a Microsoft HTTPS source');
  }
  return parsed.toString();
}

function normalizeMedia(raw) {
  const value = onlyKeys(raw, new Set(['name', 'bytes', 'sha256']), 'install media');
  if (typeof value.name !== 'string' || !FILE_NAME.test(value.name)) throw new TypeError('install media name is invalid');
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) throw new TypeError('install media bytes is invalid');
  return Object.freeze({ name: value.name, bytes: value.bytes, sha256: sha256(value.sha256, 'install media sha256') });
}

function normalizeApproval(raw, measuredSha256) {
  const value = onlyKeys(raw, new Set(['sourceClass', 'expectedSha256', 'reference', 'temporary']), 'install media approval');
  if (typeof value.sourceClass !== 'string' || !SOURCE_CLASSES.has(value.sourceClass)) throw new TypeError('install media approval sourceClass is invalid');
  const expectedSha256 = sha256(value.expectedSha256, 'install media approved sha256');
  if (expectedSha256 !== measuredSha256) throw new TypeError('install media approved digest does not match measured media');
  if (typeof value.temporary !== 'boolean') throw new TypeError('install media approval temporary is invalid');
  const evaluation = value.sourceClass === 'evaluation';
  if (evaluation && value.temporary !== true) throw new TypeError('evaluation media must be explicitly temporary');
  if (!evaluation && value.temporary !== false) throw new TypeError('durable media cannot be marked temporary');
  let reference;
  if (['official-owned', 'evaluation'].includes(value.sourceClass)) reference = microsoftReference(value.reference);
  else {
    if (typeof value.reference !== 'string' || !POLICY_REFERENCE.test(value.reference)) throw new TypeError('install media approval local policy reference is invalid');
    reference = value.reference;
  }
  return Object.freeze({ sourceClass: value.sourceClass, expectedSha256, reference, temporary: value.temporary });
}

function normalizeArchitecture(value) {
  if (!['amd64', 'arm64'].includes(value)) throw new TypeError('install media image architecture is invalid');
  return value;
}

function normalizeLanguages(raw, defaultLanguage) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) throw new TypeError('install media image languages is invalid');
  const values = [...new Set(raw.map((entry, index) => {
    if (typeof entry !== 'string' || !LANGUAGE.test(entry)) throw new TypeError(`install media image languages[${index}] is invalid`);
    return entry;
  }))].sort((left, right) => left.localeCompare(right));
  if (typeof defaultLanguage !== 'string' || !LANGUAGE.test(defaultLanguage) || !values.includes(defaultLanguage)) {
    throw new TypeError('install media image defaultLanguage is invalid');
  }
  return Object.freeze(values);
}

function normalizeImage(raw) {
  const value = onlyKeys(raw, new Set([
    'container', 'index', 'name', 'edition', 'architecture', 'version', 'build',
    'installationType', 'languages', 'defaultLanguage',
  ]), 'install media image');
  if (!['wim', 'esd'].includes(value.container)) throw new TypeError('install media image container is invalid');
  if (!Number.isSafeInteger(value.index) || value.index < 1 || value.index > 512) throw new TypeError('install media image index is invalid');
  const name = boundedText(value.name, 'install media image name');
  if (typeof value.edition !== 'string' || !EDITION.test(value.edition)) throw new TypeError('install media image edition is invalid');
  const match = typeof value.version === 'string' ? VERSION.exec(value.version) : null;
  if (!match) throw new TypeError('install media image version is invalid');
  if (!Number.isSafeInteger(value.build) || value.build < 10_000 || value.build > 999_999 || value.build !== Number(match[1])) throw new TypeError('install media image build is invalid');
  if (!['Client', 'Server'].includes(value.installationType)) throw new TypeError('install media image installationType is invalid');
  const languages = normalizeLanguages(value.languages, value.defaultLanguage);
  return Object.freeze({
    container: value.container,
    index: value.index,
    name,
    edition: value.edition,
    architecture: normalizeArchitecture(value.architecture),
    version: value.version,
    build: value.build,
    installationType: value.installationType,
    languages,
    defaultLanguage: value.defaultLanguage,
  });
}

export function normalizeWindowsInstallMediaAuthority(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'media', 'approval', 'image']), 'install media authority');
  if (value.protocol !== WINDOWS_INSTALL_MEDIA_AUTHORITY_PROTOCOL) throw new TypeError('install media authority protocol is unsupported');
  const media = normalizeMedia(value.media);
  const normalized = Object.freeze({
    protocol: WINDOWS_INSTALL_MEDIA_AUTHORITY_PROTOCOL,
    media,
    approval: normalizeApproval(value.approval, media.sha256),
    image: normalizeImage(value.image),
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_AUTHORITY_BYTES) throw new TypeError('install media authority is too large');
  return normalized;
}

export function windowsInstallMediaAuthoritySubject(raw) {
  return `subject-${digest(normalizeWindowsInstallMediaAuthority(raw)).slice(0, 32)}`;
}

export function requireWindowsInstallMediaAuthoritySubject(value) {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError('install media authority reference is invalid');
  return value;
}
