import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETUP_AUTHORITY_SNAPSHOT_PROTOCOL,
  SetupAuthorityManager,
  createSetupAuthoritySnapshot,
  exportSetupAuthorityTemplate,
  importSetupAuthorityTemplate,
  normalizeSetupAuthoritySnapshot,
  replaceSetupAuthority,
  setupAuthorityBlockers,
} from '../src/runtime/setup-authority.js';

function ref(number) {
  return `subject-${number.toString(16).padStart(32, '0')}`;
}

function authority(snapshot, profile, selectedClass) {
  return snapshot.authorities.find((entry) => entry.profile === profile && entry.class === selectedClass);
}

function replacement(snapshot, profile, selectedClass, overrides = {}) {
  return { ...authority(snapshot, profile, selectedClass), ...overrides };
}

function memoryPort() {
  let value = null;
  return {
    async load() { return structuredClone(value); },
    async save(next) { value = structuredClone(next); },
    force(next) { value = structuredClone(next); },
  };
}

test('snapshot represents no profiles, either profile, or both without inventing authority', () => {
  for (const requestedProfiles of [[], ['linux'], ['windows'], ['windows', 'linux']]) {
    const snapshot = createSetupAuthoritySnapshot({ requestedProfiles });
    assert.deepEqual(snapshot.requestedProfiles, [...requestedProfiles].sort());
    assert.equal(snapshot.authorities.length, requestedProfiles.length * 4);
    assert.equal(snapshot.authorities.every((entry) => entry.approval !== 'approved'), true);
  }
});

test('discovered availability is not approval and authorities remain independent', () => {
  let snapshot = createSetupAuthoritySnapshot({
    requestedProfiles: ['linux'],
    requirements: [
      { profile: 'linux', class: 'construction', requirement: 'required' },
      { profile: 'linux', class: 'declaration', requirement: 'required' },
    ],
  });
  snapshot = replaceSetupAuthority(snapshot, replacement(snapshot, 'linux', 'construction', {
    subjectRef: ref(1), provenance: 'discovered', approval: 'unapproved', availability: 'available',
  }));
  assert.deepEqual(setupAuthorityBlockers(snapshot).map((entry) => entry.code), [
    'construction-authority-required', 'declaration-authority-required',
  ]);
  assert.equal(authority(snapshot, 'distribution').approval, 'unapproved');
  assert.equal(authority(snapshot, 'activation').subjectRef, null);

  snapshot = replaceSetupAuthority(snapshot, replacement(snapshot, 'linux', 'construction', { approval: 'approved' }));
  assert.deepEqual(setupAuthorityBlockers(snapshot).map((entry) => entry.code), ['declaration-authority-required']);
});

test('temporary unavailability preserves an approved subject and becomes a typed blocker', () => {
  let snapshot = createSetupAuthoritySnapshot({
    requestedProfiles: ['windows'],
    requirements: [{ profile: 'windows', class: 'activation', requirement: 'required' }],
  });
  snapshot = replaceSetupAuthority(snapshot, replacement(snapshot, 'windows', 'activation', {
    subjectRef: ref(2), provenance: 'manual', approval: 'approved', availability: 'available',
  }));
  assert.equal(setupAuthorityBlockers(snapshot).length, 0);
  snapshot = replaceSetupAuthority(snapshot, replacement(snapshot, 'windows', 'activation', { availability: 'unavailable' }));
  assert.equal(authority(snapshot, 'windows', 'activation').subjectRef, ref(2));
  assert.deepEqual(setupAuthorityBlockers(snapshot).map((entry) => entry.code), ['activation-authority-unavailable']);
});

test('strict schema rejects arbitrary secret-shaped fields and non-opaque authority references', () => {
  const snapshot = createSetupAuthoritySnapshot({ requestedProfiles: ['windows'] });
  const first = snapshot.authorities[0];
  assert.throws(() => normalizeSetupAuthoritySnapshot({
    protocol: SETUP_AUTHORITY_SNAPSHOT_PROTOCOL,
    requestedProfiles: snapshot.requestedProfiles,
    authorities: [{ ...first, token: 'not-allowed' }, ...snapshot.authorities.slice(1)],
  }), /token is not allowed/u);
  assert.throws(() => replaceSetupAuthority(snapshot, { ...first, subjectRef: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' }), /opaque local subject reference/u);
});

test('sanitized export/import preserves requirements but imports no authority', () => {
  let snapshot = createSetupAuthoritySnapshot({
    requestedProfiles: ['windows'],
    requirements: [
      { profile: 'windows', class: 'construction', requirement: 'required' },
      { profile: 'windows', class: 'activation', requirement: 'required' },
    ],
  });
  snapshot = replaceSetupAuthority(snapshot, replacement(snapshot, 'windows', 'activation', {
    subjectRef: ref(3), provenance: 'manual', approval: 'approved', availability: 'available',
  }));
  const template = exportSetupAuthorityTemplate(snapshot);
  assert.equal(JSON.stringify(template).includes(ref(3)), false);
  const imported = importSetupAuthorityTemplate(template);
  const importedActivation = authority(imported, 'windows', 'activation');
  assert.equal(importedActivation.requirement, 'required');
  assert.equal(importedActivation.subjectRef, null);
  assert.equal(importedActivation.approval, 'unapproved');
  assert.equal(importedActivation.availability, 'unknown');
  assert.equal(imported.authorities.every((entry) => entry.provenance === 'imported'), true);
  assert.deepEqual(setupAuthorityBlockers(imported).map((entry) => entry.code).sort(), [
    'activation-authority-required', 'construction-authority-required',
  ]);
});

test('working edits invalidate validation and stale accepted revisions cannot commit', async () => {
  let tick = 0;
  const port = memoryPort();
  const manager = new SetupAuthorityManager({
    port,
    now: () => new Date(1_800_000_000_000 + tick++ * 1000).toISOString(),
    id: () => 'setup-operation-1',
  });
  let record = (await manager.begin()).record;
  record = await manager.replaceProfiles(record.working.operationId, {
    requestedProfiles: ['linux'],
    requirements: [
      { profile: 'linux', class: 'construction', requirement: 'required' },
      { profile: 'linux', class: 'distribution', requirement: 'none' },
      { profile: 'linux', class: 'activation', requirement: 'none' },
      { profile: 'linux', class: 'declaration', requirement: 'none' },
    ],
  });
  record = await manager.replaceAuthority(record.working.operationId, replacement(record.working.snapshot, 'linux', 'construction', {
    subjectRef: ref(4), provenance: 'recommended', approval: 'approved', availability: 'available',
  }));
  record = await manager.markValidation(record.working.operationId, 'passed');
  assert.equal(record.working.validation, 'passed');
  record = await manager.replaceAuthority(record.working.operationId, replacement(record.working.snapshot, 'linux', 'construction', {
    availability: 'unknown',
  }));
  assert.equal(record.working.validation, 'pending');
  await assert.rejects(() => manager.markValidation(record.working.operationId, 'passed'), /unresolved blockers/u);

  record = await manager.replaceAuthority(record.working.operationId, replacement(record.working.snapshot, 'linux', 'construction', {
    availability: 'available',
  }));
  record = await manager.markValidation(record.working.operationId, 'passed');
  record = await manager.commit(record.working.operationId);
  assert.equal(record.revision, 1);

  const working = (await manager.begin()).record;
  port.force({ ...working, revision: 2, updatedAt: '2027-01-15T08:00:00.000Z' });
  await assert.rejects(() => manager.commit(working.working.operationId), /accepted revision changed/u);
});
