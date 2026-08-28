import { randomUUID } from 'node:crypto';
import { createBlockerEvaluation } from './setup-authority/blocker-evaluation.js';
import { createRecordContract } from './setup-authority/record-contract.js';
import { createSnapshotContract } from './setup-authority/snapshot-contract.js';
import { createTemplateContract } from './setup-authority/template-contract.js';
import { createTransactionManager } from './setup-authority/transaction-manager.js';
import { createAuthorityValueContract } from './setup-authority/value-contract.js';

export const SETUP_AUTHORITY_SNAPSHOT_PROTOCOL = 'devbridge/setup-authority-snapshot-v1';
export const SETUP_AUTHORITY_RECORD_PROTOCOL = 'devbridge/setup-authority-record-v1';
export const SETUP_AUTHORITY_TEMPLATE_PROTOCOL = 'devbridge/setup-authority-template-v1';
export const SETUP_AUTHORITY_CLASSES = Object.freeze(['construction', 'distribution', 'activation', 'declaration']);
export const SETUP_AUTHORITY_REQUIREMENTS = Object.freeze(['required', 'optional', 'none']);
export const SETUP_AUTHORITY_APPROVAL = Object.freeze(['unapproved', 'approved', 'not-required']);
export const SETUP_AUTHORITY_AVAILABILITY = Object.freeze(['unknown', 'available', 'unavailable']);
export const SETUP_AUTHORITY_PROVENANCE = Object.freeze(['default', 'discovered', 'recommended', 'manual', 'imported']);
export const SETUP_AUTHORITY_VALIDATION = Object.freeze(['pending', 'passed', 'failed']);

const values = createAuthorityValueContract({
  classes: SETUP_AUTHORITY_CLASSES,
  requirements: SETUP_AUTHORITY_REQUIREMENTS,
  approvals: SETUP_AUTHORITY_APPROVAL,
  availabilities: SETUP_AUTHORITY_AVAILABILITY,
  provenances: SETUP_AUTHORITY_PROVENANCE,
  validations: SETUP_AUTHORITY_VALIDATION,
  maxProfiles: 1024,
});

const snapshots = createSnapshotContract({
  protocol: SETUP_AUTHORITY_SNAPSHOT_PROTOCOL,
  classes: SETUP_AUTHORITY_CLASSES,
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
  protocol: SETUP_AUTHORITY_RECORD_PROTOCOL,
  normalizeObject: values.normalizeObject,
  rejectUnknown: values.rejectUnknown,
  normalizeIdentifier: values.normalizeIdentifier,
  normalizeTimestamp: values.normalizeTimestamp,
  normalizeRevision: values.normalizeRevision,
  normalizeValidation: values.normalizeValidation,
  normalizeSnapshot: snapshots.normalizeSnapshot,
});

const templates = createTemplateContract({
  protocol: SETUP_AUTHORITY_TEMPLATE_PROTOCOL,
  classes: SETUP_AUTHORITY_CLASSES,
  normalizeObject: values.normalizeObject,
  rejectUnknown: values.rejectUnknown,
  normalizeProfiles: values.normalizeProfiles,
  normalizeRequirements: values.normalizeRequirements,
  entryKey: values.entryKey,
  createSnapshot: snapshots.createSnapshot,
  normalizeSnapshot: snapshots.normalizeSnapshot,
});

export function normalizeSetupAuthoritySnapshot(raw) {
  return snapshots.normalizeSnapshot(raw);
}

export function createSetupAuthoritySnapshot({ requestedProfiles = [], requirements = [] } = {}) {
  return snapshots.createSnapshot({ requestedProfiles, requirements });
}

export function replaceSetupProfiles(rawSnapshot, { requestedProfiles, requirements = [] } = {}) {
  return snapshots.replaceProfiles(rawSnapshot, { requestedProfiles, requirements });
}

export function replaceSetupAuthority(rawSnapshot, rawAuthority) {
  return snapshots.replaceEntry(rawSnapshot, rawAuthority);
}

export function setupAuthorityBlockers(rawSnapshot) {
  return evaluation.evaluate(rawSnapshot);
}

export function normalizeSetupAuthorityRecord(raw) {
  return records.normalizeRecord(raw);
}

export function exportSetupAuthorityTemplate(rawSnapshot) {
  return templates.exportTemplate(rawSnapshot);
}

export function importSetupAuthorityTemplate(rawTemplate) {
  return templates.importTemplate(rawTemplate);
}

export const SetupAuthorityManager = createTransactionManager({
  protocol: SETUP_AUTHORITY_RECORD_PROTOCOL,
  defaultNow: () => new Date().toISOString(),
  defaultId: () => `setup-${randomUUID()}`,
  normalizeIdentifier: values.normalizeIdentifier,
  normalizeValidation: values.normalizeValidation,
  normalizeRecord: records.normalizeRecord,
  createInitialValue: snapshots.createSnapshot,
  replaceSelection: snapshots.replaceProfiles,
  replaceEntry: snapshots.replaceEntry,
  importValue: templates.importTemplate,
  evaluateBlockers: evaluation.evaluate,
});
