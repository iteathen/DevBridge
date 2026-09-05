import { createHash } from 'node:crypto';
import { baseImageIdentity } from '../values/base-image-identity.js';
import { normalizeImmutableObject } from './immutable-object-set.js';

export const IMAGE_ARTIFACT_MANIFEST_PROTOCOL = 'devbridge/image-artifact-manifest-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_PARAMETERS = 32;
const MAX_PARAMETER_BYTES = 512;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function onlyKeys(value, allowed, name) { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`); }
function safeId(value, name) { if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function positive(value, name) { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`); return value; }
function digest(value, name) { const normalized = String(value ?? '').toLowerCase(); if (!DIGEST.test(normalized)) throw new TypeError(`${name} is invalid`); return normalized; }

function normalizeParameters(raw) {
  const value = requireObject(raw, 'image artifact encoding.parameters');
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAMETERS) throw new TypeError('image artifact encoding.parameters is too large');
  const normalized = {};
  for (const [key, rawValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const name = safeId(key, 'image artifact encoding parameter name');
    if (typeof rawValue !== 'string' || rawValue.includes('\0') || Buffer.byteLength(rawValue, 'utf8') > MAX_PARAMETER_BYTES) {
      throw new TypeError(`image artifact encoding.parameters.${name} is invalid`);
    }
    normalized[name] = rawValue;
  }
  return Object.freeze(normalized);
}

function normalizeImage(raw) {
  const value = requireObject(raw, 'image artifact image');
  onlyKeys(value, new Set(['identity', 'profile', 'generation', 'format', 'virtualSize', 'size', 'sha256', 'bootstrap']), 'image artifact image');
  const profile = safeId(value.profile, 'image artifact image.profile');
  const generation = safeId(value.generation, 'image artifact image.generation');
  const sha256 = digest(value.sha256, 'image artifact image.sha256');
  const identity = safeId(value.identity, 'image artifact image.identity');
  if (identity !== baseImageIdentity(profile, generation, sha256)) throw new TypeError('image artifact image.identity does not match its semantic image subject');
  return Object.freeze({
    identity,
    profile,
    generation,
    format: safeId(value.format, 'image artifact image.format').toLowerCase(),
    virtualSize: positive(value.virtualSize, 'image artifact image.virtualSize'),
    size: positive(value.size, 'image artifact image.size'),
    sha256,
    bootstrap: safeId(value.bootstrap, 'image artifact image.bootstrap'),
  });
}

function normalizeEncoding(raw) {
  const value = requireObject(raw, 'image artifact encoding');
  onlyKeys(value, new Set(['algorithm', 'parameters', 'size', 'sha256']), 'image artifact encoding');
  return Object.freeze({
    algorithm: safeId(value.algorithm, 'image artifact encoding.algorithm'),
    parameters: normalizeParameters(value.parameters),
    size: positive(value.size, 'image artifact encoding.size'),
    sha256: digest(value.sha256, 'image artifact encoding.sha256'),
  });
}

export function normalizeImageArtifactManifest(raw) {
  const value = requireObject(raw, 'image artifact manifest');
  onlyKeys(value, new Set(['protocol', 'image', 'encoding', 'chunks']), 'image artifact manifest');
  if (value.protocol !== IMAGE_ARTIFACT_MANIFEST_PROTOCOL) throw new TypeError('image artifact manifest protocol is unsupported');
  const image = normalizeImage(value.image);
  const encoding = normalizeEncoding(value.encoding);
  const encodedObject = normalizeImmutableObject({
    name: 'encoded-image-object',
    size: encoding.size,
    sha256: encoding.sha256,
    chunks: value.chunks,
  }, { context: 'image artifact encoded object' });
  return Object.freeze({
    protocol: IMAGE_ARTIFACT_MANIFEST_PROTOCOL,
    image,
    encoding,
    chunks: encodedObject.chunks,
  });
}

export function serializeImageArtifactManifest(raw) {
  return `${JSON.stringify(normalizeImageArtifactManifest(raw))}\n`;
}

export function imageArtifactManifestDigest(raw) {
  return createHash('sha256').update(serializeImageArtifactManifest(raw), 'utf8').digest('hex');
}
