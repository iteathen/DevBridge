import { createHash } from 'node:crypto';
import path from 'node:path';

const TOKEN = /^[a-f0-9]{32}$/u;
const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MIN_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MIN_DISK_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DISK_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
const MAX_PROCESSORS = 256;
const TRUST_TEMPLATES = Object.freeze({ 'platform-owner': 'MicrosoftWindows' });

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function mediaIdentity(raw, name) {
  const value = onlyKeys(raw, new Set(['location', 'bytes', 'sha256']), name);
  if (typeof value.location !== 'string' || value.location.length === 0 || value.location.includes('\0')) throw new TypeError(`${name}.location is invalid`);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) throw new TypeError(`${name}.bytes is invalid`);
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) throw new TypeError(`${name}.sha256 is invalid`);
  return { location: value.location, bytes: value.bytes, sha256: value.sha256 };
}

function networkIdentity(raw) {
  const value = onlyKeys(raw, new Set(['control', 'reference', 'proof']), 'construction network');
  if (!['owned', 'system'].includes(value.control)) throw new TypeError('construction network.control is invalid');
  if (typeof value.reference !== 'string' || !REFERENCE.test(value.reference)) throw new TypeError('construction network.reference is invalid');
  if (typeof value.proof !== 'string' || value.proof.length === 0 || value.proof.length > 2048 || value.proof.includes('\0')) throw new TypeError('construction network.proof is invalid');
  if (value.control === 'system' && !GUID.test(value.reference)) throw new TypeError('system construction network.reference must be an exact provider identity');
  if (value.control === 'system' && value.proof !== value.reference) throw new TypeError('system construction network.proof does not bind its exact provider identity');
  return { control: value.control, reference: value.reference, proof: value.proof };
}

export class HyperVConstructionRequest {
  #identity;
  #outputRoot;
  #normalizeProtection;

  constructor({ identity, outputRoot, normalizeProtection }) {
    if (typeof identity !== 'string' || !TOKEN.test(identity)) throw new TypeError('construction provider identity is invalid');
    if (typeof normalizeProtection !== 'function') throw new TypeError('construction protection normalizer is required');
    this.#identity = identity;
    this.#outputRoot = path.resolve(outputRoot);
    this.#normalizeProtection = normalizeProtection;
  }

  subject(value) {
    if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError('construction identity is invalid');
    return value;
  }

  normalize(raw) {
    const value = onlyKeys(raw, new Set(['identity', 'installer', 'seed', 'dataMedia', 'memoryBytes', 'processorCount', 'diskBytes', 'network', 'bootProtection']), 'construction request');
    const bootProtection = this.#normalizeProtection(value.bootProtection, { optional: true, name: 'construction request.bootProtection' });
    return {
      identity: this.subject(value.identity),
      installer: mediaIdentity(value.installer, 'construction installer'),
      seed: mediaIdentity(value.seed, 'construction seed'),
      ...(value.dataMedia === undefined ? {} : { dataMedia: mediaIdentity(value.dataMedia, 'construction data media') }),
      memoryBytes: boundedInteger(value.memoryBytes, MIN_MEMORY_BYTES, MAX_MEMORY_BYTES, 'construction memoryBytes'),
      processorCount: boundedInteger(value.processorCount, 1, MAX_PROCESSORS, 'construction processorCount'),
      diskBytes: boundedInteger(value.diskBytes, MIN_DISK_BYTES, MAX_DISK_BYTES, 'construction diskBytes'),
      network: networkIdentity(value.network),
      bootProtection,
    };
  }

  bootSettings(protection) {
    return {
      integrityRequired: protection?.integrity === 'required',
      identityRequired: protection?.identity === 'required',
      trustTemplate: protection ? TRUST_TEMPLATES[protection.trust] : null,
    };
  }

  validateRecordMedia(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('construction record is invalid');
    if (Object.hasOwn(record, 'dataMedia')) mediaIdentity(record.dataMedia, 'construction recorded data media');
  }

  create(request) {
    const key = createHash('sha256').update(`${this.#identity}:${request.identity}`).digest('hex').slice(0, 32);
    return {
      identity: request.identity,
      key,
      name: `db-image-build-${createHash('sha256').update(`${this.#identity}:${request.identity}`).digest('hex').slice(0, 16)}`,
      marker: `devbridge-owned:${this.#identity}:image-build:${request.identity}:v1`,
      diskName: `${createHash('sha256').update(`${this.#identity}:image-disk:${request.identity}`).digest('hex')}.vhdx`,
    };
  }

  descriptor(record) {
    return {
      name: record.name,
      marker: record.marker,
      providerIdentity: record.providerIdentity ?? '',
      configPath: path.join(this.#outputRoot, `${record.key}-vm`),
      diskPath: path.join(this.#outputRoot, record.diskName),
    };
  }

  same(record, request) {
    return record.identity === request.identity
      && record.installer.sha256 === request.installer.sha256
      && record.installer.bytes === request.installer.bytes
      && record.seed.sha256 === request.seed.sha256
      && record.seed.bytes === request.seed.bytes
      && Boolean(record.dataMedia) === Boolean(request.dataMedia)
      && (!record.dataMedia || (record.dataMedia.location === request.dataMedia.location
        && record.dataMedia.bytes === request.dataMedia.bytes && record.dataMedia.sha256 === request.dataMedia.sha256))
      && record.memoryBytes === request.memoryBytes
      && record.processorCount === request.processorCount
      && record.diskBytes === request.diskBytes
      && record.network.control === request.network.control
      && record.network.reference === request.network.reference
      && record.network.proof === request.network.proof
      && JSON.stringify(record.bootProtection ?? null) === JSON.stringify(request.bootProtection);
  }
}
