import { randomUUID } from 'node:crypto';

export const SETUP_AUTHORITY_SNAPSHOT_PROTOCOL = 'devbridge/setup-authority-snapshot-v1';
export const SETUP_AUTHORITY_RECORD_PROTOCOL = 'devbridge/setup-authority-record-v1';
export const SETUP_AUTHORITY_TEMPLATE_PROTOCOL = 'devbridge/setup-authority-template-v1';
export const SETUP_AUTHORITY_CLASSES = Object.freeze(['construction', 'distribution', 'activation', 'declaration']);
export const SETUP_AUTHORITY_REQUIREMENTS = Object.freeze(['required', 'optional', 'none']);
export const SETUP_AUTHORITY_APPROVAL = Object.freeze(['unapproved', 'approved', 'not-required']);
export const SETUP_AUTHORITY_AVAILABILITY = Object.freeze(['unknown', 'available', 'unavailable']);
export const SETUP_AUTHORITY_PROVENANCE = Object.freeze(['default', 'discovered', 'recommended', 'manual', 'imported']);
export const SETUP_AUTHORITY_VALIDATION = Object.freeze(['pending', 'passed', 'failed']);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const OPAQUE_REF = /^subject-[a-f0-9]{32}$/u;
const MAX_PROFILES = 1024;
const MAX_AUTHORITIES = MAX_PROFILES * SETUP_AUTHORITY_CLASSES.length;
const CLASS_ORDER = new Map(SETUP_AUTHORITY_CLASSES.map((value, index) => [value, index]));

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function opaqueRef(value, name) {
  if (typeof value !== 'string' || !OPAQUE_REF.test(value)) throw new TypeError(`${name} must be an opaque local subject reference`);
  return value;
}

function enumValue(value, values, name) {
  if (!values.includes(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid`);
  return value;
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
  return value;
}

function normalizeProfiles(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_PROFILES) throw new TypeError('setup requestedProfiles is invalid');
  const values = raw.map((value, index) => safeId(value, `setup requestedProfiles[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError('setup requestedProfiles contains duplicates');
  return Object.freeze(values.sort((left, right) => left.localeCompare(right)));
}

function authorityClass(value, name) {
  return enumValue(value, SETUP_AUTHORITY_CLASSES, name);
}

function authorityRequirement(value, name) {
  return enumValue(value, SETUP_AUTHORITY_REQUIREMENTS, name);
}

function authorityKey(profile, selectedClass) {
  return `${profile}\0${selectedClass}`;
}

function defaultAuthority(profile, selectedClass, requirement = 'optional', provenance = 'default') {
  const normalizedRequirement = authorityRequirement(requirement, 'setup authority requirement');
  return Object.freeze({
    profile: safeId(profile, 'setup authority profile'),
    class: authorityClass(selectedClass, 'setup authority class'),
    requirement: normalizedRequirement,
    approval: normalizedRequirement === 'none' ? 'not-required' : 'unapproved',
    availability: 'unknown',
    subjectRef: null,
    provenance: enumValue(provenance, SETUP_AUTHORITY_PROVENANCE, 'setup authority provenance'),
  });
}

function normalizeAuthority(raw, index, requestedProfiles) {
  const value = requireObject(raw, `setup authorities[${index}]`);
  onlyKeys(value, new Set(['profile', 'class', 'requirement', 'approval', 'availability', 'subjectRef', 'provenance']), `setup authorities[${index}]`);
  const profile = safeId(value.profile, `setup authorities[${index}].profile`);
  if (!requestedProfiles.has(profile)) throw new TypeError('setup authority belongs to an unrequested profile');
  const selectedClass = authorityClass(value.class, `setup authorities[${index}].class`);
  const requirement = authorityRequirement(value.requirement, `setup authorities[${index}].requirement`);
  const approval = enumValue(value.approval, SETUP_AUTHORITY_APPROVAL, `setup authorities[${index}].approval`);
  const availability = enumValue(value.availability, SETUP_AUTHORITY_AVAILABILITY, `setup authorities[${index}].availability`);
  const subjectRef = value.subjectRef == null ? null : opaqueRef(value.subjectRef, `setup authorities[${index}].subjectRef`);
  const provenance = enumValue(value.provenance, SETUP_AUTHORITY_PROVENANCE, `setup authorities[${index}].provenance`);

  if (requirement === 'none') {
    if (approval !== 'not-required' || availability !== 'unknown' || subjectRef !== null) {
      throw new TypeError('setup authority marked not required cannot carry approval, availability, or a subject');
    }
  } else {
    if (approval === 'not-required') throw new TypeError('setup authority approval contradicts its requirement');
    if (approval === 'approved' && subjectRef === null) throw new TypeError('approved setup authority requires an opaque subject reference');
    if (subjectRef === null && availability !== 'unknown') throw new TypeError('setup authority availability requires an opaque subject reference');
  }

  return Object.freeze({ profile, class: selectedClass, requirement, approval, availability, subjectRef, provenance });
}

function compareAuthorities(left, right) {
  const byProfile = left.profile.localeCompare(right.profile);
  if (byProfile !== 0) return byProfile;
  return CLASS_ORDER.get(left.class) - CLASS_ORDER.get(right.class);
}

export function normalizeSetupAuthoritySnapshot(raw) {
  const value = requireObject(raw, 'setup authority snapshot');
  onlyKeys(value, new Set(['protocol', 'requestedProfiles', 'authorities']), 'setup authority snapshot');
  if (value.protocol !== SETUP_AUTHORITY_SNAPSHOT_PROTOCOL) throw new TypeError('setup authority snapshot protocol is unsupported');
  const requestedProfiles = normalizeProfiles(value.requestedProfiles);
  if (!Array.isArray(value.authorities) || value.authorities.length > MAX_AUTHORITIES) throw new TypeError('setup authorities is invalid');
  if (value.authorities.length !== requestedProfiles.length * SETUP_AUTHORITY_CLASSES.length) {
    throw new TypeError('setup authorities must contain every authority class for every requested profile');
  }
  const requestedSet = new Set(requestedProfiles);
  const seen = new Set();
  const authorities = value.authorities.map((entry, index) => {
    const normalized = normalizeAuthority(entry, index, requestedSet);
    const key = authorityKey(normalized.profile, normalized.class);
    if (seen.has(key)) throw new TypeError('setup authorities contains a duplicate profile/class pair');
    seen.add(key);
    return normalized;
  });
  for (const profile of requestedProfiles) {
    for (const selectedClass of SETUP_AUTHORITY_CLASSES) {
      if (!seen.has(authorityKey(profile, selectedClass))) throw new TypeError('setup authorities is incomplete');
    }
  }
  return Object.freeze({
    protocol: SETUP_AUTHORITY_SNAPSHOT_PROTOCOL,
    requestedProfiles,
    authorities: Object.freeze(authorities.sort(compareAuthorities)),
  });
}

function requirementMap(raw, requestedProfiles) {
  if (!Array.isArray(raw) || raw.length > MAX_AUTHORITIES) throw new TypeError('setup authority requirements is invalid');
  const profiles = new Set(requestedProfiles);
  const values = new Map();
  raw.forEach((entry, index) => {
    const value = requireObject(entry, `setup authority requirements[${index}]`);
    onlyKeys(value, new Set(['profile', 'class', 'requirement']), `setup authority requirements[${index}]`);
    const profile = safeId(value.profile, `setup authority requirements[${index}].profile`);
    if (!profiles.has(profile)) throw new TypeError('setup authority requirement belongs to an unrequested profile');
    const selectedClass = authorityClass(value.class, `setup authority requirements[${index}].class`);
    const requirement = authorityRequirement(value.requirement, `setup authority requirements[${index}].requirement`);
    const key = authorityKey(profile, selectedClass);
    if (values.has(key)) throw new TypeError('setup authority requirements contains a duplicate profile/class pair');
    values.set(key, requirement);
  });
  return values;
}

export function createSetupAuthoritySnapshot({ requestedProfiles = [], requirements = [] } = {}) {
  const profiles = normalizeProfiles(requestedProfiles);
  const overrides = requirementMap(requirements, profiles);
  return normalizeSetupAuthoritySnapshot({
    protocol: SETUP_AUTHORITY_SNAPSHOT_PROTOCOL,
    requestedProfiles: profiles,
    authorities: profiles.flatMap((profile) => SETUP_AUTHORITY_CLASSES.map((selectedClass) => (
      defaultAuthority(profile, selectedClass, overrides.get(authorityKey(profile, selectedClass)) ?? 'optional')
    ))),
  });
}

export function replaceSetupProfiles(rawSnapshot, { requestedProfiles, requirements = [] } = {}) {
  const current = normalizeSetupAuthoritySnapshot(rawSnapshot);
  const profiles = normalizeProfiles(requestedProfiles);
  const overrides = requirementMap(requirements, profiles);
  const existing = new Map(current.authorities.map((entry) => [authorityKey(entry.profile, entry.class), entry]));
  const authorities = [];
  for (const profile of profiles) {
    for (const selectedClass of SETUP_AUTHORITY_CLASSES) {
      const key = authorityKey(profile, selectedClass);
      const prior = existing.get(key) ?? null;
      const requirement = overrides.get(key) ?? prior?.requirement ?? 'optional';
      authorities.push(prior && prior.requirement === requirement
        ? prior
        : defaultAuthority(profile, selectedClass, requirement));
    }
  }
  return normalizeSetupAuthoritySnapshot({ protocol: SETUP_AUTHORITY_SNAPSHOT_PROTOCOL, requestedProfiles: profiles, authorities });
}

export function replaceSetupAuthority(rawSnapshot, rawAuthority) {
  const current = normalizeSetupAuthoritySnapshot(rawSnapshot);
  const requestedSet = new Set(current.requestedProfiles);
  const replacement = normalizeAuthority(rawAuthority, 0, requestedSet);
  const target = authorityKey(replacement.profile, replacement.class);
  let changed = false;
  const authorities = current.authorities.map((entry) => {
    if (authorityKey(entry.profile, entry.class) !== target) return entry;
    changed = true;
    return replacement;
  });
  if (!changed) throw new TypeError('setup authority replacement target does not exist');
  return normalizeSetupAuthoritySnapshot({ ...current, authorities });
}

export function setupAuthorityBlockers(rawSnapshot) {
  const snapshot = normalizeSetupAuthoritySnapshot(rawSnapshot);
  const blockers = [];
  for (const authority of snapshot.authorities) {
    if (authority.provenance === 'imported') {
      blockers.push(Object.freeze({
        code: `${authority.class}-authority-revalidation-required`,
        profile: authority.profile,
        authorityClass: authority.class,
        action: 'revalidate',
      }));
      continue;
    }
    if (authority.requirement !== 'required') continue;
    if (authority.approval !== 'approved') {
      blockers.push(Object.freeze({
        code: `${authority.class}-authority-required`,
        profile: authority.profile,
        authorityClass: authority.class,
        action: 'approve',
      }));
      continue;
    }
    if (authority.availability === 'unavailable') {
      blockers.push(Object.freeze({
        code: `${authority.class}-authority-unavailable`,
        profile: authority.profile,
        authorityClass: authority.class,
        action: 'restore',
      }));
      continue;
    }
    if (authority.availability !== 'available') {
      blockers.push(Object.freeze({
        code: `${authority.class}-authority-unverified`,
        profile: authority.profile,
        authorityClass: authority.class,
        action: 'verify',
      }));
    }
  }
  return Object.freeze(blockers);
}

function normalizeWorking(raw, recordRevision) {
  const value = requireObject(raw, 'setup authority working generation');
  onlyKeys(value, new Set(['operationId', 'baseRevision', 'snapshot', 'validation', 'updatedAt']), 'setup authority working generation');
  const baseRevision = nonnegativeInteger(value.baseRevision, 'setup authority working baseRevision');
  if (baseRevision > recordRevision) throw new TypeError('setup authority working baseRevision is newer than accepted state');
  return Object.freeze({
    operationId: safeId(value.operationId, 'setup authority operationId'),
    baseRevision,
    snapshot: normalizeSetupAuthoritySnapshot(value.snapshot),
    validation: enumValue(value.validation, SETUP_AUTHORITY_VALIDATION, 'setup authority validation'),
    updatedAt: timestamp(value.updatedAt, 'setup authority working timestamp'),
  });
}

export function normalizeSetupAuthorityRecord(raw) {
  const value = requireObject(raw, 'setup authority record');
  onlyKeys(value, new Set(['protocol', 'revision', 'accepted', 'working', 'updatedAt']), 'setup authority record');
  if (value.protocol !== SETUP_AUTHORITY_RECORD_PROTOCOL) throw new TypeError('setup authority record protocol is unsupported');
  const revision = nonnegativeInteger(value.revision, 'setup authority revision');
  const accepted = value.accepted == null ? null : normalizeSetupAuthoritySnapshot(value.accepted);
  if (revision === 0 && accepted !== null) throw new TypeError('setup authority revision zero cannot have accepted state');
  if (revision > 0 && accepted === null) throw new TypeError('setup authority accepted state is missing for its revision');
  return Object.freeze({
    protocol: SETUP_AUTHORITY_RECORD_PROTOCOL,
    revision,
    accepted,
    working: value.working == null ? null : normalizeWorking(value.working, revision),
    updatedAt: timestamp(value.updatedAt, 'setup authority record timestamp'),
  });
}

function normalizeTemplate(raw) {
  const value = requireObject(raw, 'setup authority template');
  onlyKeys(value, new Set(['protocol', 'requestedProfiles', 'requirements']), 'setup authority template');
  if (value.protocol !== SETUP_AUTHORITY_TEMPLATE_PROTOCOL) throw new TypeError('setup authority template protocol is unsupported');
  const requestedProfiles = normalizeProfiles(value.requestedProfiles);
  const requirements = requirementMap(value.requirements, requestedProfiles);
  if (requirements.size !== requestedProfiles.length * SETUP_AUTHORITY_CLASSES.length) {
    throw new TypeError('setup authority template requirements must contain every authority class for every requested profile');
  }
  return Object.freeze({
    protocol: SETUP_AUTHORITY_TEMPLATE_PROTOCOL,
    requestedProfiles,
    requirements: Object.freeze(requestedProfiles.flatMap((profile) => SETUP_AUTHORITY_CLASSES.map((selectedClass) => Object.freeze({
      profile,
      class: selectedClass,
      requirement: requirements.get(authorityKey(profile, selectedClass)),
    })))),
  });
}

export function exportSetupAuthorityTemplate(rawSnapshot) {
  const snapshot = normalizeSetupAuthoritySnapshot(rawSnapshot);
  return normalizeTemplate({
    protocol: SETUP_AUTHORITY_TEMPLATE_PROTOCOL,
    requestedProfiles: snapshot.requestedProfiles,
    requirements: snapshot.authorities.map(({ profile, class: selectedClass, requirement }) => ({
      profile,
      class: selectedClass,
      requirement,
    })),
  });
}

export function importSetupAuthorityTemplate(rawTemplate) {
  const template = normalizeTemplate(rawTemplate);
  const snapshot = createSetupAuthoritySnapshot({
    requestedProfiles: template.requestedProfiles,
    requirements: template.requirements,
  });
  return normalizeSetupAuthoritySnapshot({
    ...snapshot,
    authorities: snapshot.authorities.map((authority) => ({ ...authority, provenance: 'imported' })),
  });
}

export class SetupAuthorityManager {
  #port;
  #now;
  #id;

  constructor({ port, now = () => new Date().toISOString(), id = () => `setup-${randomUUID()}` } = {}) {
    if (!port || typeof port.load !== 'function' || typeof port.save !== 'function') throw new TypeError('setup authority persistence port is incomplete');
    if (typeof now !== 'function' || typeof id !== 'function') throw new TypeError('setup authority dependencies are invalid');
    this.#port = port;
    this.#now = now;
    this.#id = id;
  }

  async current() {
    const raw = await this.#port.load();
    return raw == null ? null : normalizeSetupAuthorityRecord(raw);
  }

  async begin() {
    const current = await this.current();
    if (current?.working) return Object.freeze({ resumed: true, record: current });
    const now = this.#now();
    const revision = current?.revision ?? 0;
    const accepted = current?.accepted ?? null;
    const next = normalizeSetupAuthorityRecord({
      protocol: SETUP_AUTHORITY_RECORD_PROTOCOL,
      revision,
      accepted,
      working: {
        operationId: safeId(this.#id(), 'setup authority operation identity'),
        baseRevision: revision,
        snapshot: accepted ?? createSetupAuthoritySnapshot(),
        validation: 'pending',
        updatedAt: now,
      },
      updatedAt: now,
    });
    await this.#port.save(next);
    return Object.freeze({ resumed: false, record: next });
  }

  async #working(operationId) {
    const current = await this.current();
    if (!current?.working) throw new Error('setup authority working generation does not exist');
    if (current.working.operationId !== safeId(operationId, 'setup authority operation identity')) throw new Error('setup authority operation identity does not match current working generation');
    return current;
  }

  async #saveEdit(current, snapshot) {
    const now = this.#now();
    const next = normalizeSetupAuthorityRecord({
      ...current,
      working: { ...current.working, snapshot, validation: 'pending', updatedAt: now },
      updatedAt: now,
    });
    await this.#port.save(next);
    return next;
  }

  async replaceProfiles(operationId, input) {
    const current = await this.#working(operationId);
    return this.#saveEdit(current, replaceSetupProfiles(current.working.snapshot, input));
  }

  async replaceAuthority(operationId, authority) {
    const current = await this.#working(operationId);
    return this.#saveEdit(current, replaceSetupAuthority(current.working.snapshot, authority));
  }

  async importTemplate(operationId, template) {
    const current = await this.#working(operationId);
    return this.#saveEdit(current, importSetupAuthorityTemplate(template));
  }

  async markValidation(operationId, outcome) {
    const current = await this.#working(operationId);
    const validation = enumValue(outcome, SETUP_AUTHORITY_VALIDATION, 'setup authority validation');
    if (validation === 'pending') throw new TypeError('setup authority validation outcome must be terminal for this working generation');
    if (validation === 'passed') {
      const blockers = setupAuthorityBlockers(current.working.snapshot);
      if (blockers.length > 0) throw new Error(`setup authority working generation has unresolved blockers: ${blockers.map((entry) => entry.code).join(', ')}`);
    }
    const now = this.#now();
    const next = normalizeSetupAuthorityRecord({
      ...current,
      working: { ...current.working, validation, updatedAt: now },
      updatedAt: now,
    });
    await this.#port.save(next);
    return next;
  }

  async commit(operationId) {
    const current = await this.#working(operationId);
    if (current.working.validation !== 'passed') throw new Error('setup authority working generation is not validated');
    if (current.working.baseRevision !== current.revision) throw new Error('setup authority accepted revision changed; re-read before commit');
    const now = this.#now();
    const next = normalizeSetupAuthorityRecord({
      protocol: SETUP_AUTHORITY_RECORD_PROTOCOL,
      revision: current.revision + 1,
      accepted: current.working.snapshot,
      working: null,
      updatedAt: now,
    });
    await this.#port.save(next);
    return next;
  }

  async discard(operationId) {
    const current = await this.#working(operationId);
    const now = this.#now();
    const next = normalizeSetupAuthorityRecord({ ...current, working: null, updatedAt: now });
    await this.#port.save(next);
    return next;
  }
}
