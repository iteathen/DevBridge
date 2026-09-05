import { createHash } from 'node:crypto';
import {
  environmentDeclarationDigest,
  logicalEnvironmentIdentity,
  normalizeEnvironmentDeclaration,
} from './environment-declaration.js';

export const ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL = 'devbridge/environment-profile-configuration-v1';
export const ENVIRONMENT_PROFILE_CONFIGURATION_RECORD_PROTOCOL = 'devbridge/environment-profile-configuration-record-v1';
export const ENVIRONMENT_PROFILE_RECONCILIATION_PROTOCOL = 'devbridge/environment-profile-reconciliation-v1';

const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_PROFILES = 64;
const MAX_TOTAL_WORKSPACES = 4096;
const MAX_CONFIGURATION_BYTES = 2 * 1024 * 1024;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid`);
  return value;
}

export function normalizeEnvironmentProfileConfiguration(raw) {
  const value = requireObject(raw, 'environment profile configuration');
  onlyKeys(value, new Set(['protocol', 'declarations']), 'environment profile configuration');
  if (value.protocol !== ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL) throw new TypeError('environment profile configuration protocol is unsupported');
  if (!Array.isArray(value.declarations) || value.declarations.length > MAX_PROFILES) {
    throw new TypeError('environment profile configuration declarations are invalid');
  }
  const declarations = value.declarations.map((entry) => normalizeEnvironmentDeclaration(entry));
  const totalWorkspaces = declarations.reduce((total, entry) => total + entry.workspaces.length, 0);
  if (totalWorkspaces > MAX_TOTAL_WORKSPACES) throw new TypeError('environment profile configuration contains too many workspaces');
  const profiles = declarations.map((entry) => entry.profile);
  if (new Set(profiles).size !== profiles.length) throw new TypeError('environment profile configuration contains duplicate profiles');
  const normalized = Object.freeze({
    protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
    declarations: Object.freeze(declarations.sort((left, right) => left.profile.localeCompare(right.profile))),
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_CONFIGURATION_BYTES) {
    throw new TypeError('environment profile configuration exceeds its size bound');
  }
  return normalized;
}

export function environmentProfileConfigurationDigest(raw) {
  const configuration = normalizeEnvironmentProfileConfiguration(raw);
  return createHash('sha256')
    .update('devbridge/environment-profile-configuration-digest-v1\0', 'utf8')
    .update(JSON.stringify(configuration), 'utf8')
    .digest('hex');
}

export function normalizeEnvironmentProfileConfigurationRecord(raw) {
  const value = requireObject(raw, 'environment profile configuration record');
  onlyKeys(value, new Set(['protocol', 'revision', 'digest', 'configuration', 'updatedAt']), 'environment profile configuration record');
  if (value.protocol !== ENVIRONMENT_PROFILE_CONFIGURATION_RECORD_PROTOCOL) throw new TypeError('environment profile configuration record protocol is unsupported');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new TypeError('environment profile configuration revision is invalid');
  const configuration = normalizeEnvironmentProfileConfiguration(value.configuration);
  const digest = environmentProfileConfigurationDigest(configuration);
  if (typeof value.digest !== 'string' || !DIGEST.test(value.digest) || value.digest !== digest) {
    throw new TypeError('environment profile configuration digest is invalid');
  }
  return Object.freeze({
    protocol: ENVIRONMENT_PROFILE_CONFIGURATION_RECORD_PROTOCOL,
    revision: value.revision,
    digest,
    configuration,
    updatedAt: timestamp(value.updatedAt, 'environment profile configuration timestamp'),
  });
}

export class EnvironmentProfileConfigurationRegistry {
  #port;
  #now;

  constructor({ port, now = () => new Date().toISOString() } = {}) {
    if (!port || typeof port.load !== 'function' || typeof port.save !== 'function') {
      throw new TypeError('environment profile configuration persistence port is incomplete');
    }
    if (typeof now !== 'function') throw new TypeError('environment profile configuration clock is invalid');
    this.#port = port;
    this.#now = now;
  }

  async current() {
    const raw = await this.#port.load();
    return raw == null ? null : normalizeEnvironmentProfileConfigurationRecord(raw);
  }

  async publish(rawConfiguration) {
    const configuration = normalizeEnvironmentProfileConfiguration(rawConfiguration);
    const digest = environmentProfileConfigurationDigest(configuration);
    const current = await this.current();
    if (current?.digest === digest) return Object.freeze({ changed: false, record: current });
    const next = normalizeEnvironmentProfileConfigurationRecord({
      protocol: ENVIRONMENT_PROFILE_CONFIGURATION_RECORD_PROTOCOL,
      revision: (current?.revision ?? 0) + 1,
      digest,
      configuration,
      updatedAt: this.#now(),
    });
    await this.#port.save(next);
    return Object.freeze({ changed: true, record: next });
  }
}

function assertDeclarations(value) {
  if (!value || typeof value.list !== 'function' || typeof value.get !== 'function' || typeof value.register !== 'function') {
    throw new TypeError('environment profile declaration contract is incomplete');
  }
  return value;
}

function assertImages(value) {
  if (!value || typeof value.list !== 'function' || typeof value.verify !== 'function') {
    throw new TypeError('environment profile image contract is incomplete');
  }
  return value;
}

function exactImageEntry(entries, declaration) {
  const matches = entries.filter((entry) => entry?.identity === declaration.image.identity);
  if (matches.length !== 1) throw new Error('environment profile image identity is unavailable or ambiguous');
  const [entry] = matches;
  if (entry.retiredAt != null || entry.profile !== declaration.profile || entry.generation !== declaration.image.generation) {
    throw new Error('environment profile image does not match declaration authority');
  }
  return entry;
}

function sameDeclaration(left, right) {
  return environmentDeclarationDigest(left) === environmentDeclarationDigest(right);
}

export async function reconcileEnvironmentProfileConfiguration(rawRecord, {
  declarations,
  images,
} = {}) {
  const record = normalizeEnvironmentProfileConfigurationRecord(rawRecord);
  const declarationAuthority = assertDeclarations(declarations);
  const imageAuthority = assertImages(images);
  const desired = record.configuration.declarations;
  const desiredProfiles = new Set(desired.map((entry) => entry.profile));
  const [existing, inventory] = await Promise.all([declarationAuthority.list(), imageAuthority.list()]);
  if (!Array.isArray(existing) || !Array.isArray(inventory)) throw new TypeError('environment profile authority inventory is invalid');
  if (existing.length > MAX_PROFILES || inventory.length > 256) throw new Error('environment profile authority inventory exceeds its bound');
  const unexpected = existing.filter((entry) => !desiredProfiles.has(entry?.declaration?.profile));
  if (unexpected.length > 0) throw new Error('protected declaration authority contains profiles outside accepted configuration');

  const observations = [];
  for (const declaration of desired) {
    exactImageEntry(inventory, declaration);
    const verified = await imageAuthority.verify(declaration.image.identity);
    if (verified?.identity !== declaration.image.identity || verified?.verified !== true || verified?.usable !== true) {
      throw new Error('environment profile image failed exact protected verification');
    }
    const current = await declarationAuthority.get(logicalEnvironmentIdentity(declaration.profile));
    if (current && current.declaration?.profile !== declaration.profile) throw new Error('environment profile declaration identity is ambiguous');
    observations.push(Object.freeze({ declaration, current }));
  }

  let changed = false;
  const applied = [];
  for (const observation of observations) {
    let current = observation.current;
    if (!current || !sameDeclaration(current.declaration, observation.declaration)) {
      const result = await declarationAuthority.register(observation.declaration, { expectedRevision: current?.revision ?? null });
      changed ||= result.changed === true;
      current = result.record;
    }
    const confirmed = await declarationAuthority.get(logicalEnvironmentIdentity(observation.declaration.profile));
    if (!confirmed || confirmed.identity !== logicalEnvironmentIdentity(observation.declaration.profile)
        || !Number.isSafeInteger(confirmed.revision) || confirmed.revision < 1
        || confirmed.revision !== current.revision || !sameDeclaration(confirmed.declaration, observation.declaration)) {
      throw new Error('environment profile declaration did not reconcile to accepted authority');
    }
    applied.push(Object.freeze({
      identity: confirmed.identity,
      profile: confirmed.declaration.profile,
      revision: confirmed.revision,
      digest: environmentDeclarationDigest(confirmed.declaration),
    }));
  }

  return Object.freeze({
    protocol: ENVIRONMENT_PROFILE_RECONCILIATION_PROTOCOL,
    ready: true,
    changed,
    configurationRevision: record.revision,
    configurationDigest: record.digest,
    declarations: Object.freeze(applied),
  });
}

export function inspectEnvironmentProfileConfiguration(rawRecord, rawStatuses) {
  const record = normalizeEnvironmentProfileConfigurationRecord(rawRecord);
  if (!Array.isArray(rawStatuses)) throw new TypeError('environment profile status inventory is invalid');
  const desired = record.configuration.declarations;
  if (rawStatuses.length !== desired.length) {
    return Object.freeze({ ready: false, blocker: 'protected declarations do not match accepted profile configuration' });
  }
  for (const declaration of desired) {
    const matches = rawStatuses.filter((entry) => entry?.profile === declaration.profile);
    if (matches.length !== 1 || matches[0].declarationDigest !== environmentDeclarationDigest(declaration)
        || !Number.isSafeInteger(matches[0].declarationRevision) || matches[0].declarationRevision < 1) {
      return Object.freeze({ ready: false, blocker: 'protected declarations do not match accepted profile configuration' });
    }
  }
  return Object.freeze({ ready: true, blocker: null });
}

export { MAX_CONFIGURATION_BYTES as ENVIRONMENT_PROFILE_CONFIGURATION_MAX_BYTES };
