import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRevisionedRecordStateStore } from '../state/revisioned-record-state-store.js';

const PROTOCOL = 'devbridge/setup-protected-apply-frontier-v1';
const SUBJECT = 'protected-apply';
const STATES = new Set(['prepared', 'applied', 'invalidated']);
const DIGEST = /^[a-f0-9]{64}$/u;

function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('setup protected-apply frontier is invalid');
  const allowed = new Set(['protocol', 'revision', 'state', 'subjectDigest', 'configurationRevision', 'configurationDigest', 'profileSelectionRevision', 'setupDigest', 'updatedAt']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError('setup protected-apply frontier contains an unknown field');
  if (raw.protocol !== PROTOCOL || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !STATES.has(raw.state)) {
    throw new TypeError('setup protected-apply frontier is invalid');
  }
  if (typeof raw.subjectDigest !== 'string' || !DIGEST.test(raw.subjectDigest)
      || typeof raw.configurationDigest !== 'string' || !DIGEST.test(raw.configurationDigest)
      || typeof raw.setupDigest !== 'string' || !DIGEST.test(raw.setupDigest)
      || !Number.isSafeInteger(raw.configurationRevision) || raw.configurationRevision < 1
      || !Number.isSafeInteger(raw.profileSelectionRevision) || raw.profileSelectionRevision < 1) {
    throw new TypeError('setup protected-apply frontier subject is invalid');
  }
  return Object.freeze({
    protocol: PROTOCOL,
    revision: raw.revision,
    state: raw.state,
    subjectDigest: raw.subjectDigest,
    configurationRevision: raw.configurationRevision,
    configurationDigest: raw.configurationDigest,
    profileSelectionRevision: raw.profileSelectionRevision,
    setupDigest: raw.setupDigest,
    updatedAt: timestamp(raw.updatedAt, 'setup protected-apply frontier timestamp'),
  });
}

function setupCheckpointDigest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.protocol !== 'devbridge/setup-status-v1'
      || !Number.isSafeInteger(raw.identity?.id) || raw.identity.id < 1 || typeof raw.identity.login !== 'string'
      || !Array.isArray(raw.repositories?.selected)) {
    throw new TypeError('setup protected-apply setup checkpoint is invalid');
  }
  const repositories = raw.repositories.selected.map((entry) => {
    if (!Number.isSafeInteger(entry?.id) || entry.id < 1 || typeof entry.fullName !== 'string'
        || !/^[^/\s]+\/[^/\s]+$/u.test(entry.fullName) || typeof entry.private !== 'boolean') {
      throw new TypeError('setup protected-apply repository checkpoint is invalid');
    }
    return Object.freeze({ id: entry.id, fullName: entry.fullName, private: entry.private });
  });
  if (new Set(repositories.map((entry) => entry.id)).size !== repositories.length) {
    throw new TypeError('setup protected-apply repository checkpoint is ambiguous');
  }
  const snapshot = raw.ubuntu == null ? null : raw.ubuntu.snapshot;
  if (snapshot != null && (typeof snapshot !== 'string' || !/^\d{8}T\d{6}Z$/u.test(snapshot))) {
    throw new TypeError('setup protected-apply package checkpoint is invalid');
  }
  const value = Object.freeze({
    identity: Object.freeze({ id: raw.identity.id, login: raw.identity.login }),
    repositories: Object.freeze(repositories),
    snapshot,
  });
  return createHash('sha256')
    .update('devbridge/setup-protected-apply-checkpoint-v1\0', 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function subject(record, profileSelectionRevision, setupCheckpoint) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || typeof record.digest !== 'string' || !DIGEST.test(record.digest)) {
    throw new TypeError('setup protected-apply configuration authority is invalid');
  }
  if (!Number.isSafeInteger(profileSelectionRevision) || profileSelectionRevision < 1) {
    throw new TypeError('setup protected-apply profile-selection revision is invalid');
  }
  const value = Object.freeze({
    configurationRevision: record.revision,
    configurationDigest: record.digest,
    profileSelectionRevision,
    setupDigest: setupCheckpointDigest(setupCheckpoint),
  });
  return Object.freeze({
    ...value,
    subjectDigest: createHash('sha256')
      .update('devbridge/setup-protected-apply-subject-v1\0', 'utf8')
      .update(JSON.stringify(value), 'utf8')
      .digest('hex'),
  });
}

function sameSubject(record, expected) {
  return record.subjectDigest === expected.subjectDigest
    && record.configurationRevision === expected.configurationRevision
    && record.configurationDigest === expected.configurationDigest
    && record.profileSelectionRevision === expected.profileSelectionRevision
    && record.setupDigest === expected.setupDigest;
}

export function createSetupProtectedApplyFrontier({ stateDirectory, now = () => new Date().toISOString() } = {}, {
  storeFactory = createRevisionedRecordStateStore,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || !path.isAbsolute(stateDirectory)) {
    throw new TypeError('setup protected-apply state directory is invalid');
  }
  if (typeof now !== 'function' || typeof storeFactory !== 'function') throw new TypeError('setup protected-apply dependencies are invalid');
  const store = storeFactory(path.join(path.resolve(stateDirectory), 'setup-protected-apply.json'));
  if (!store || typeof store.run !== 'function') throw new TypeError('setup protected-apply persistence port is incomplete');

  async function current() {
    return store.run(SUBJECT, async (port) => {
      const raw = await port.load();
      return raw == null ? null : normalizeRecord(raw);
    });
  }

  async function transition(state, configurationRecord, profileSelectionRevision, setupCheckpoint) {
    if (!STATES.has(state)) throw new TypeError('setup protected-apply transition is invalid');
    const expected = subject(configurationRecord, profileSelectionRevision, setupCheckpoint);
    return store.run(SUBJECT, async (port) => {
      const raw = await port.load();
      const prior = raw == null ? null : normalizeRecord(raw);
      if (prior && sameSubject(prior, expected) && prior.state === state) return Object.freeze({ changed: false, record: prior });
      const next = normalizeRecord({
        protocol: PROTOCOL,
        revision: (prior?.revision ?? 0) + 1,
        state,
        ...expected,
        updatedAt: now(),
      });
      await port.save(next);
      return Object.freeze({ changed: true, record: next });
    });
  }

  return Object.freeze({
    current,
    prepare: (record, revision, checkpoint) => transition('prepared', record, revision, checkpoint),
    apply: (record, revision, checkpoint) => transition('applied', record, revision, checkpoint),
    invalidate: (record, revision, checkpoint) => transition('invalidated', record, revision, checkpoint),
    matches(record, configurationRecord, profileSelectionRevision, setupCheckpoint, state = null) {
      const value = normalizeRecord(record);
      return sameSubject(value, subject(configurationRecord, profileSelectionRevision, setupCheckpoint)) && (state == null || value.state === state);
    },
  });
}

export { PROTOCOL as SETUP_PROTECTED_APPLY_FRONTIER_PROTOCOL };
