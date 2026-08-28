import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlockerEvaluation } from '../src/runtime/setup-authority/blocker-evaluation.js';
import { createRecordContract } from '../src/runtime/setup-authority/record-contract.js';
import { createSnapshotContract } from '../src/runtime/setup-authority/snapshot-contract.js';
import { createTemplateContract } from '../src/runtime/setup-authority/template-contract.js';
import { createTransactionManager } from '../src/runtime/setup-authority/transaction-manager.js';
import { createAuthorityValueContract } from '../src/runtime/setup-authority/value-contract.js';

const SNAPSHOT_PROTOCOL = 'devbridge/setup-authority-snapshot-v1';
const RECORD_PROTOCOL = 'devbridge/setup-authority-record-v1';
const TEMPLATE_PROTOCOL = 'devbridge/setup-authority-template-v1';
const CLASSES = Object.freeze(['construction', 'distribution', 'activation', 'declaration']);

function contracts() {
  const values = createAuthorityValueContract({
    classes: CLASSES,
    requirements: Object.freeze(['required', 'optional', 'none']),
    approvals: Object.freeze(['unapproved', 'approved', 'not-required']),
    availabilities: Object.freeze(['unknown', 'available', 'unavailable']),
    provenances: Object.freeze(['default', 'discovered', 'recommended', 'manual', 'imported']),
    validations: Object.freeze(['pending', 'passed', 'failed']),
    maxProfiles: 1024,
  });
  const snapshots = createSnapshotContract({
    protocol: SNAPSHOT_PROTOCOL,
    classes: CLASSES,
    maxEntries: values.maxEntries,
    normalizeObject: values.normalizeObject,
    rejectUnknown: values.rejectUnknown,
    normalizeProfiles: values.normalizeProfiles,
    normalizeEntry: values.normalizeEntry,
    normalizeRequirements: values.normalizeRequirements,
    entryKey: values.entryKey,
    createDefaultEntry: values.createDefaultEntry,
    compareEntries: values.compareEntries,
  });
  const evaluation = createBlockerEvaluation({ normalizeSnapshot: snapshots.normalizeSnapshot });
  const records = createRecordContract({
    protocol: RECORD_PROTOCOL,
    normalizeObject: values.normalizeObject,
    rejectUnknown: values.rejectUnknown,
    normalizeIdentifier: values.normalizeIdentifier,
    normalizeTimestamp: values.normalizeTimestamp,
    normalizeRevision: values.normalizeRevision,
    normalizeValidation: values.normalizeValidation,
    normalizeSnapshot: snapshots.normalizeSnapshot,
  });
  const templates = createTemplateContract({
    protocol: TEMPLATE_PROTOCOL,
    classes: CLASSES,
    normalizeObject: values.normalizeObject,
    rejectUnknown: values.rejectUnknown,
    normalizeProfiles: values.normalizeProfiles,
    normalizeRequirements: values.normalizeRequirements,
    entryKey: values.entryKey,
    createSnapshot: snapshots.createSnapshot,
    normalizeSnapshot: snapshots.normalizeSnapshot,
  });
  return { values, snapshots, evaluation, records, templates };
}

function requirementRows(profile, selected = {}) {
  return CLASSES.map((authorityClass) => ({
    profile,
    class: authorityClass,
    requirement: selected[authorityClass] ?? 'none',
  }));
}

function entry(snapshot, profile, authorityClass) {
  return snapshot.authorities.find((value) => value.profile === profile && value.class === authorityClass);
}

test('nested value and snapshot contracts retain strict immutable ordered values', () => {
  const { snapshots } = contracts();
  const snapshot = snapshots.createSnapshot({
    requestedProfiles: ['profile-z', 'profile-a'],
    requirements: [
      ...requirementRows('profile-z', { construction: 'required' }),
      ...requirementRows('profile-a', { activation: 'optional' }),
    ],
  });
  assert.deepEqual(snapshot.requestedProfiles, ['profile-a', 'profile-z']);
  assert.deepEqual(snapshot.authorities.map((value) => `${value.profile}:${value.class}`), [
    'profile-a:construction', 'profile-a:distribution', 'profile-a:activation', 'profile-a:declaration',
    'profile-z:construction', 'profile-z:distribution', 'profile-z:activation', 'profile-z:declaration',
  ]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.requestedProfiles), true);
  assert.equal(Object.isFrozen(snapshot.authorities), true);
  assert.equal(snapshot.authorities.every(Object.isFrozen), true);

  const replaced = snapshots.replaceEntry(snapshot, {
    ...entry(snapshot, 'profile-z', 'construction'),
    approval: 'approved',
    availability: 'available',
    subjectRef: 'subject-00000000000000000000000000000001',
    provenance: 'manual',
  });
  assert.equal(entry(replaced, 'profile-z', 'construction').approval, 'approved');
  assert.equal(entry(replaced, 'profile-a', 'construction').approval, 'not-required');
  assert.throws(() => snapshots.normalizeSnapshot({ ...snapshot, extra: true }), /snapshot.extra is not allowed/u);
  assert.throws(() => snapshots.replaceEntry(snapshot, {
    ...entry(snapshot, 'profile-z', 'construction'), subjectRef: 'foreign-value', approval: 'approved',
  }), /opaque local subject reference/u);
});

test('nested blocker evaluation is pure, bounded, ordered, and cannot accept imported values', () => {
  const { snapshots, evaluation, templates } = contracts();
  let snapshot = snapshots.createSnapshot({
    requestedProfiles: ['profile-a'],
    requirements: requirementRows('profile-a', { construction: 'required', activation: 'required' }),
  });
  snapshot = snapshots.replaceEntry(snapshot, {
    ...entry(snapshot, 'profile-a', 'construction'),
    approval: 'approved',
    availability: 'unavailable',
    subjectRef: 'subject-00000000000000000000000000000002',
    provenance: 'manual',
  });
  assert.deepEqual(evaluation.evaluate(snapshot).map((value) => value.code), [
    'construction-authority-unavailable',
    'activation-authority-required',
  ]);
  const imported = templates.importTemplate(templates.exportTemplate(snapshot));
  const blockers = evaluation.evaluate(imported);
  assert.deepEqual(blockers.map((value) => value.action), ['revalidate', 'revalidate', 'revalidate', 'revalidate']);
  assert.equal(Object.isFrozen(blockers), true);
  assert.equal(blockers.every(Object.isFrozen), true);
});

test('nested record contract preserves accepted and working generation invariants', () => {
  const { snapshots, records } = contracts();
  const snapshot = snapshots.createSnapshot({ requestedProfiles: ['profile-a'] });
  const record = records.normalizeRecord({
    protocol: RECORD_PROTOCOL,
    revision: 1,
    accepted: snapshot,
    working: {
      operationId: 'operation-1',
      baseRevision: 1,
      snapshot,
      validation: 'pending',
      updatedAt: '2027-01-15T08:00:00.000Z',
    },
    updatedAt: '2027-01-15T08:00:00.000Z',
  });
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.working), true);
  assert.equal(record.working.snapshot.protocol, SNAPSHOT_PROTOCOL);
  assert.throws(() => records.normalizeRecord({ ...record, revision: 0 }), /revision zero cannot have accepted state/u);
  assert.throws(() => records.normalizeRecord({ ...record, accepted: null }), /accepted state is missing/u);
  assert.throws(() => records.normalizeRecord({
    ...record,
    working: { ...record.working, baseRevision: 2 },
  }), /baseRevision is newer/u);
});

test('nested template contract exports requirements only and imports no accepted authority', () => {
  const { snapshots, templates, evaluation } = contracts();
  let snapshot = snapshots.createSnapshot({
    requestedProfiles: ['profile-a'],
    requirements: requirementRows('profile-a', { activation: 'required' }),
  });
  snapshot = snapshots.replaceEntry(snapshot, {
    ...entry(snapshot, 'profile-a', 'activation'),
    approval: 'approved',
    availability: 'available',
    subjectRef: 'subject-00000000000000000000000000000003',
    provenance: 'manual',
  });
  const template = templates.exportTemplate(snapshot);
  assert.equal(JSON.stringify(template).includes('subject-'), false);
  assert.equal(Object.isFrozen(template), true);
  assert.equal(template.requirements.every(Object.isFrozen), true);
  const imported = templates.importTemplate(template);
  assert.equal(imported.authorities.every((value) => value.provenance === 'imported'), true);
  assert.equal(imported.authorities.every((value) => value.subjectRef === null), true);
  assert.equal(evaluation.evaluate(imported).length, CLASSES.length);
});

test('nested transaction manager retains load-save order, validation invalidation, acceptance, and discard', async () => {
  const { values, snapshots, evaluation, records, templates } = contracts();
  const trace = [];
  let stored = null;
  let tick = 0;
  const port = {
    async load() { trace.push('load'); return structuredClone(stored); },
    async save(value) { trace.push('save'); stored = structuredClone(value); },
  };
  const Manager = createTransactionManager({
    protocol: RECORD_PROTOCOL,
    defaultNow: () => new Date(1_800_000_000_000 + tick++ * 1000).toISOString(),
    defaultId: () => 'operation-1',
    normalizeIdentifier: values.normalizeIdentifier,
    normalizeValidation: values.normalizeValidation,
    normalizeRecord: records.normalizeRecord,
    createInitialValue: snapshots.createSnapshot,
    replaceSelection: snapshots.replaceProfiles,
    replaceEntry: snapshots.replaceEntry,
    importValue: templates.importTemplate,
    evaluateBlockers: evaluation.evaluate,
  });
  const manager = new Manager({ port });
  let record = (await manager.begin()).record;
  record = await manager.replaceProfiles(record.working.operationId, {
    requestedProfiles: ['profile-a'],
    requirements: requirementRows('profile-a', { construction: 'required' }),
  });
  record = await manager.replaceAuthority(record.working.operationId, {
    ...entry(record.working.snapshot, 'profile-a', 'construction'),
    approval: 'approved',
    availability: 'available',
    subjectRef: 'subject-00000000000000000000000000000004',
    provenance: 'recommended',
  });
  record = await manager.markValidation(record.working.operationId, 'passed');
  record = await manager.commit(record.working.operationId);
  assert.equal(record.revision, 1);
  assert.equal(record.working, null);
  assert.equal(entry(record.accepted, 'profile-a', 'construction').availability, 'available');
  assert.deepEqual(trace, ['load', 'save', 'load', 'save', 'load', 'save', 'load', 'save', 'load', 'save']);

  record = (await manager.begin()).record;
  record = await manager.markValidation(record.working.operationId, 'passed');
  record = await manager.replaceAuthority(record.working.operationId, {
    ...entry(record.working.snapshot, 'profile-a', 'construction'), availability: 'unavailable',
  });
  assert.equal(record.working.validation, 'pending');
  await assert.rejects(() => manager.markValidation(record.working.operationId, 'passed'), /unresolved blockers/u);
  const discarded = await manager.discard(record.working.operationId);
  assert.equal(discarded.working, null);
  assert.equal(entry(discarded.accepted, 'profile-a', 'construction').availability, 'available');
});

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : [target];
  }));
  return nested.flat();
}

test('setup-authority parent alone composes import-free topology-neutral nested children', async () => {
  const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
  const parent = path.join(sourceRoot, 'runtime', 'setup-authority.js');
  const childDirectory = path.join(sourceRoot, 'runtime', 'setup-authority');
  const childFiles = (await readdir(childDirectory)).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(childFiles, [
    'blocker-evaluation.js',
    'record-contract.js',
    'snapshot-contract.js',
    'template-contract.js',
    'transaction-manager.js',
    'value-contract.js',
  ]);
  const parentText = await readFile(parent, 'utf8');
  const forbidden = /(?:GitHub|Hyper-V|libvirt|DPAPI|Microsoft|Ubuntu|VHDX|qcow2|repository|remote.?agent|virtual.?machine|JsonStateStore|profile-selection|distribution-policy|activation-policy)/iu;
  for (const child of childFiles) {
    const text = await readFile(path.join(childDirectory, child), 'utf8');
    assert.doesNotMatch(text, /^\s*import\s/mu, child);
    assert.doesNotMatch(text, forbidden, child);
    assert.match(parentText, new RegExp(`from ['\"]\\./setup-authority/${child.replace('.', '\\.') }['\"]`, 'u'), child);
  }
  for (const file of (await sourceFiles(sourceRoot)).filter((name) => name.endsWith('.js') && name !== parent)) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /from ['"][^'"]*\/setup-authority\/(?:blocker-evaluation|record-contract|snapshot-contract|template-contract|transaction-manager|value-contract)\.js['"]/u, file);
  }
});
