import { createHash } from 'node:crypto';

export const CANONICAL_IMAGE_CANARY_PROTOCOL = 'devbridge/canonical-image-canary-v1';

const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const IMAGE = /^img-[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PHASES = new Set([
  'planned',
  'prepared',
  'installing',
  'qualifying',
  'probed',
  'finalization-planned',
  'finalization-attempted',
  'finalized',
  'qualified',
  'retained',
  'published',
  'completed',
]);
const MAX_OPAQUE_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 256 * 1024;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeJson(value, name, depth = 0) {
  if (depth > 32) throw new TypeError(`${name} is too deeply nested`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new TypeError(`${name} contains too many entries`);
    return value.map((entry, index) => normalizeJson(entry, `${name}[${index}]`, depth + 1));
  }
  if (!value || typeof value !== 'object') throw new TypeError(`${name} must contain JSON data only`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${name} must contain plain JSON objects only`);
  const keys = Object.keys(value).sort();
  if (keys.length > 4096) throw new TypeError(`${name} contains too many fields`);
  const result = {};
  for (const key of keys) {
    if (!key || key.length > 256 || /[\u0000-\u001f\u007f]/u.test(key)) throw new TypeError(`${name} contains an invalid field name`);
    result[key] = normalizeJson(value[key], `${name}.${key}`, depth + 1);
  }
  return result;
}

function boundedJson(value, name, maxBytes = MAX_OPAQUE_BYTES) {
  const normalized = normalizeJson(value, name);
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > maxBytes) throw new TypeError(`${name} is too large`);
  return normalized;
}

function normalizeProvenance(raw) {
  const value = onlyKeys(raw, new Set(Object.keys(raw ?? {})), 'canary image provenance');
  const normalized = {};
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 32) throw new TypeError('canary image provenance is invalid');
  for (const [key, entry] of entries) {
    safeId(key, 'canary image provenance key');
    if (typeof entry !== 'string' || entry.includes('\0') || Buffer.byteLength(entry, 'utf8') > 4096) throw new TypeError(`canary image provenance.${key} is invalid`);
    normalized[key] = entry;
  }
  if (typeof normalized.origin !== 'string' || normalized.origin.length === 0) throw new TypeError('canary image provenance.origin is required');
  return normalized;
}

function normalizeOutput(raw) {
  const value = onlyKeys(raw, new Set(['profile', 'generation', 'provenance']), 'canary image output');
  return Object.freeze({
    profile: safeId(value.profile, 'canary image profile'),
    generation: safeId(value.generation, 'canary image generation'),
    provenance: Object.freeze(normalizeProvenance(value.provenance)),
  });
}

function normalizeRequest(raw) {
  const value = onlyKeys(raw, new Set(['identity', 'work', 'check', 'output']), 'canary request');
  if (typeof value.identity !== 'string' || !SUBJECT.test(value.identity)) throw new TypeError('canary identity is invalid');
  return Object.freeze({
    identity: value.identity,
    work: boundedJson(value.work, 'canary work'),
    check: boundedJson(value.check, 'canary check'),
    output: normalizeOutput(value.output),
  });
}

function stableDigest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function assertJournal(value) {
  if (!value || typeof value.load !== 'function' || typeof value.save !== 'function') throw new TypeError('canary journal contract is incomplete');
  return value;
}

function assertConstruction(value) {
  const methods = ['prepare', 'status', 'startInstall', 'bootInstalled', 'markQualified', 'retain'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('canary construction contract is incomplete');
  return value;
}

function assertQualification(value) {
  if (!value || typeof value.probe !== 'function' || typeof value.finalize !== 'function') throw new TypeError('canary qualification contract is incomplete');
  return value;
}

function assertImages(value) {
  if (!value || typeof value.publishImage !== 'function' || typeof value.verifyImage !== 'function') throw new TypeError('canary image admission contract is incomplete');
  return value;
}

function requireIdentityResult(raw, identity, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.identity !== identity) throw new Error(`${name} identity changed`);
  return raw;
}

function normalizeImageReceipt(raw, output) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.identity !== 'string' || !IMAGE.test(raw.identity)) {
    throw new Error('canary image admission returned an invalid identity');
  }
  if (raw.profile !== output.profile || raw.generation !== output.generation) throw new Error('canary image admission changed output identity');
  if (typeof raw.digest !== 'string' || !SHA256.test(raw.digest)) throw new Error('canary image admission returned an invalid digest');
  if (!Number.isSafeInteger(raw.size) || raw.size < 1) throw new Error('canary image admission returned an invalid size');
  return Object.freeze({ identity: raw.identity, profile: raw.profile, generation: raw.generation, digest: raw.digest, size: raw.size });
}

function normalizeRecord(raw, identity, requestDigest) {
  if (raw == null) return null;
  const value = onlyKeys(raw, new Set(['protocol', 'identity', 'requestDigest', 'revision', 'phase', 'probe', 'finalization', 'image']), 'canary journal record');
  if (value.protocol !== CANONICAL_IMAGE_CANARY_PROTOCOL || value.identity !== identity || value.requestDigest !== requestDigest) {
    throw new Error('canary journal authority does not match the requested subject');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('canary journal revision is invalid');
  if (!PHASES.has(value.phase)) throw new Error('canary journal phase is invalid');
  const probe = value.probe == null ? null : boundedJson(value.probe, 'canary probe evidence', MAX_EVIDENCE_BYTES);
  const finalization = value.finalization == null ? null : boundedJson(value.finalization, 'canary finalization evidence', MAX_EVIDENCE_BYTES);
  let image = null;
  if (value.image != null) {
    const receipt = onlyKeys(value.image, new Set(['identity', 'profile', 'generation', 'digest', 'size']), 'canary image receipt');
    if (typeof receipt.identity !== 'string' || !IMAGE.test(receipt.identity)) throw new Error('canary journal image identity is invalid');
    if (typeof receipt.profile !== 'string' || !SAFE_ID.test(receipt.profile) || typeof receipt.generation !== 'string' || !SAFE_ID.test(receipt.generation)) throw new Error('canary journal image subject is invalid');
    if (typeof receipt.digest !== 'string' || !SHA256.test(receipt.digest) || !Number.isSafeInteger(receipt.size) || receipt.size < 1) throw new Error('canary journal image receipt is invalid');
    image = { ...receipt };
  }
  return { protocol: value.protocol, identity, requestDigest, revision: value.revision, phase: value.phase, probe, finalization, image };
}

function publicStatus(record, reason = null) {
  return Object.freeze({
    protocol: CANONICAL_IMAGE_CANARY_PROTOCOL,
    identity: record.identity,
    phase: record.phase,
    revision: record.revision,
    complete: record.phase === 'completed',
    blocked: reason != null,
    reason,
    image: record.image == null ? null : Object.freeze({ ...record.image }),
  });
}

export class CanonicalImageCanary {
  #journal;
  #construction;
  #qualification;
  #images;

  constructor({ journal, construction, qualification, images } = {}) {
    this.#journal = assertJournal(journal);
    this.#construction = assertConstruction(construction);
    this.#qualification = assertQualification(qualification);
    this.#images = assertImages(images);
  }

  async #save(record, phase, changes = {}) {
    const next = {
      ...record,
      ...changes,
      protocol: CANONICAL_IMAGE_CANARY_PROTOCOL,
      phase,
      revision: record.revision + 1,
    };
    await this.#journal.save(record.identity, next);
    return next;
  }

  async inspect(rawRequest) {
    const request = normalizeRequest(rawRequest);
    const requestDigest = stableDigest(request);
    const record = normalizeRecord(await this.#journal.load(request.identity), request.identity, requestDigest);
    if (!record) return Object.freeze({ protocol: CANONICAL_IMAGE_CANARY_PROTOCOL, identity: request.identity, phase: 'absent', revision: 0, complete: false, blocked: false, reason: null, image: null });
    const reason = record.phase === 'finalization-attempted'
      ? 'destructive finalization was attempted without a durable completion receipt; exact reconciliation is required before reuse or admission'
      : null;
    return publicStatus(record, reason);
  }

  async advance(rawRequest) {
    const request = normalizeRequest(rawRequest);
    const requestDigest = stableDigest(request);
    let record = normalizeRecord(await this.#journal.load(request.identity), request.identity, requestDigest);

    if (!record) {
      record = {
        protocol: CANONICAL_IMAGE_CANARY_PROTOCOL,
        identity: request.identity,
        requestDigest,
        revision: 0,
        phase: 'planned',
        probe: null,
        finalization: null,
        image: null,
      };
      record = await this.#save(record, 'planned');
      return publicStatus(record);
    }

    if (record.phase === 'completed') return publicStatus(record);

    if (record.phase === 'finalization-attempted') {
      requireIdentityResult(await this.#construction.status(request.identity), request.identity, 'canary finalization observation');
      return publicStatus(record, 'destructive finalization was attempted without a durable completion receipt; exact reconciliation is required before reuse or admission');
    }

    if (record.phase === 'planned') {
      requireIdentityResult(await this.#construction.prepare(structuredClone(request.work)), request.identity, 'canary preparation');
      record = await this.#save(record, 'prepared');
      return publicStatus(record);
    }

    if (record.phase === 'prepared') {
      requireIdentityResult(await this.#construction.startInstall(request.identity), request.identity, 'canary start');
      record = await this.#save(record, 'installing');
      return publicStatus(record);
    }

    if (record.phase === 'installing') {
      requireIdentityResult(await this.#construction.bootInstalled(request.identity), request.identity, 'canary activation');
      record = await this.#save(record, 'qualifying');
      return publicStatus(record);
    }

    if (record.phase === 'qualifying') {
      const probe = boundedJson(await this.#qualification.probe({ target: request.identity, expected: structuredClone(request.check) }), 'canary probe evidence', MAX_EVIDENCE_BYTES);
      record = await this.#save(record, 'probed', { probe });
      return publicStatus(record);
    }

    if (record.phase === 'probed') {
      record = await this.#save(record, 'finalization-planned');
      return publicStatus(record);
    }

    if (record.phase === 'finalization-planned') {
      record = await this.#save(record, 'finalization-attempted');
      const finalization = boundedJson(await this.#qualification.finalize(request.identity), 'canary finalization evidence', MAX_EVIDENCE_BYTES);
      record = await this.#save(record, 'finalized', { finalization });
      return publicStatus(record);
    }

    if (record.phase === 'finalized') {
      const evidence = { probe: structuredClone(record.probe), finalization: structuredClone(record.finalization) };
      requireIdentityResult(await this.#construction.markQualified(request.identity, evidence), request.identity, 'canary qualification acceptance');
      record = await this.#save(record, 'qualified');
      return publicStatus(record);
    }

    if (record.phase === 'qualified') {
      const retained = requireIdentityResult(await this.#construction.retain(request.identity), request.identity, 'canary retention');
      if (typeof retained.location !== 'string' || retained.location.length === 0 || retained.location.includes('\0')) throw new Error('canary retention did not expose a bounded admission source');
      record = await this.#save(record, 'retained');
      return publicStatus(record);
    }

    if (record.phase === 'retained') {
      const retained = requireIdentityResult(await this.#construction.retain(request.identity), request.identity, 'canary retained observation');
      if (typeof retained.location !== 'string' || retained.location.length === 0 || retained.location.includes('\0')) throw new Error('canary retained observation did not expose a bounded admission source');
      const published = await this.#images.publishImage({
        profile: request.output.profile,
        generation: request.output.generation,
        source: retained.location,
        provenance: structuredClone(request.output.provenance),
      });
      const image = normalizeImageReceipt(published, request.output);
      record = await this.#save(record, 'published', { image });
      return publicStatus(record);
    }

    if (record.phase === 'published') {
      const verified = await this.#images.verifyImage(record.image.identity);
      if (!verified || verified.identity !== record.image.identity || verified.usable !== true || verified.verified !== true) throw new Error('canary published image did not verify through the admission boundary');
      record = await this.#save(record, 'completed');
      return publicStatus(record);
    }

    throw new Error(`canary phase is not advanceable: ${record.phase}`);
  }
}

export function createCanonicalImageCanary(options) {
  return new CanonicalImageCanary(options);
}
