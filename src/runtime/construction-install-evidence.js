import { createHash } from 'node:crypto';

export const INSTALLER_EVIDENCE_PROTOCOL = 'devbridge/installer-evidence-v1';
export const CONSTRUCTION_INSTALL_EVIDENCE_PROTOCOL = 'devbridge/construction-install-evidence-v1';
export const INSTALLER_EVIDENCE_MAX_BYTES = 64 * 1024;
const STREAM_BYTES = 16 * 1024;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function object(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError(`${name} fields are invalid`);
  return value;
}

function normalizeBinding(raw) {
  const value = object(raw, ['subject', 'providerInstance', 'seedSha256', 'attempt'], 'installation evidence binding');
  if (typeof value.subject !== 'string' || typeof value.providerInstance !== 'string'
      || !TOKEN.test(value.subject) || !TOKEN.test(value.providerInstance)
      || typeof value.seedSha256 !== 'string' || !SHA256.test(value.seedSha256)
      || !Number.isSafeInteger(value.attempt) || value.attempt < 1) throw new TypeError('installation evidence binding is invalid');
  return { subject: value.subject, providerInstance: value.providerInstance, seedSha256: value.seedSha256, attempt: value.attempt };
}

function normalizeReport(raw) {
  const value = object(raw, ['sequence', 'phase', 'stage', 'exitCode', 'collection', 'truncated', 'stdout', 'stderr'], 'installation report');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !['installing', 'failed', 'finished'].includes(value.phase)
      || typeof value.stage !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/u.test(value.stage)
      || !['complete', 'partial', 'unavailable'].includes(value.collection)
      || typeof value.truncated !== 'boolean') throw new TypeError('installation report is invalid');
  if (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)) throw new TypeError('installation exit status is invalid');
  if ((value.phase === 'installing' && value.exitCode !== null)
      || (value.phase === 'failed' && value.exitCode === 0)
      || (value.phase === 'finished' && value.exitCode !== 0)) throw new TypeError('installation outcome contradicts its exit status');
  for (const stream of ['stdout', 'stderr']) {
    if (typeof value[stream] !== 'string' || Buffer.byteLength(value[stream], 'utf8') > STREAM_BYTES) throw new TypeError('installation diagnostic stream is outside bounds');
    if (Buffer.from(value[stream], 'utf8').toString('utf8') !== value[stream]) throw new TypeError('installation diagnostic text is invalid');
  }
  if (value.collection === 'unavailable' && (value.stdout || value.stderr)) throw new TypeError('unavailable installation diagnostics contain output');
  return {
    sequence: value.sequence, phase: value.phase, stage: value.stage, exitCode: value.exitCode,
    collection: value.collection, truncated: value.truncated, stdout: value.stdout, stderr: value.stderr,
  };
}

function digest(report) { return createHash('sha256').update(JSON.stringify(report)).digest('hex'); }

function sameOutcome(left, right) {
  return left.phase === right.phase && left.stage === right.stage && left.exitCode === right.exitCode;
}

function decodeStream(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(STREAM_BYTES / 3) * 4) throw new TypeError('installation diagnostic encoding is outside bounds');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > STREAM_BYTES || bytes.toString('base64') !== value) throw new TypeError('installation diagnostic encoding is invalid');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function decodeInstallerEvidence(bytes, rawBinding) {
  const binding = normalizeBinding(rawBinding);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > INSTALLER_EVIDENCE_MAX_BYTES) throw new TypeError('installation evidence frame is outside bounds');
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const value = object(raw, ['protocol', 'identity', 'attempt', 'sequence', 'phase', 'stage', 'exitCode', 'collection', 'truncated', 'stdoutBase64', 'stderrBase64'], 'installation evidence frame');
  if (value.protocol !== INSTALLER_EVIDENCE_PROTOCOL || value.identity !== binding.subject || value.attempt !== binding.attempt) throw new TypeError('installation evidence subject changed');
  return normalizeReport({
    sequence: value.sequence, phase: value.phase, stage: value.stage, exitCode: value.exitCode,
    collection: value.collection, truncated: value.truncated,
    stdout: decodeStream(value.stdoutBase64), stderr: decodeStream(value.stderrBase64),
  });
}

function previousState(raw, binding) {
  if (raw == null) return { report: null, reportSha256: null, failure: null, failureSha256: null, reportObservedAt: null };
  const value = object(raw, ['protocol', 'binding', 'report', 'reportSha256', 'failure', 'failureSha256', 'reportObservedAt', 'collection'], 'saved installation evidence');
  if (value.protocol !== CONSTRUCTION_INSTALL_EVIDENCE_PROTOCOL
      || JSON.stringify(normalizeBinding(value.binding)) !== JSON.stringify(binding)) throw new TypeError('saved installation evidence binding changed');
  const report = value.report == null ? null : normalizeReport(value.report);
  const failure = value.failure == null ? null : normalizeReport(value.failure);
  if ((report == null && (value.reportSha256 !== null || value.reportObservedAt !== null))
      || (report != null && (value.reportSha256 !== digest(report) || typeof value.reportObservedAt !== 'string' || !Number.isFinite(Date.parse(value.reportObservedAt))))
      || (failure == null && (value.failureSha256 !== null || report?.phase === 'failed'))
      || (failure != null && (value.failureSha256 !== digest(failure) || failure.phase !== 'failed' || report?.phase !== 'failed'
        || failure.stage !== report.stage || failure.exitCode !== report.exitCode || failure.sequence > report.sequence))) throw new TypeError('saved installation evidence is inconsistent');
  const collection = object(value.collection, ['status', 'observedAt', 'reason'], 'saved installation collection');
  if (!['available', 'unavailable', 'invalid', 'stale'].includes(collection.status)
      || typeof collection.observedAt !== 'string' || !Number.isFinite(Date.parse(collection.observedAt))
      || (collection.reason !== null && (typeof collection.reason !== 'string' || collection.reason.length > 512))) throw new TypeError('saved installation collection is invalid');
  return { report, reportSha256: value.reportSha256, failure, failureSha256: value.failureSha256, reportObservedAt: value.reportObservedAt };
}

export function inspectConstructionInstallEvidence(raw, rawBinding) {
  if (raw == null) return null;
  const binding = normalizeBinding(rawBinding);
  const state = previousState(raw, binding);
  return { protocol: CONSTRUCTION_INSTALL_EVIDENCE_PROTOCOL, binding, ...state, collection: { ...raw.collection } };
}

// The caller owns persistence and verifies the provider attachment before this
// boundary. Guest success is evidence only; it is never image acceptance.
export function checkpointConstructionInstallEvidence({ binding: rawBinding, previous = null, observation, now }) {
  const binding = normalizeBinding(rawBinding);
  const state = previousState(previous, binding);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('installation observation time is invalid');
  const observedAt = now.toISOString();
  let collection;
  if (observation?.status === 'unavailable') {
    object(observation, ['status', 'reason'], 'installation transport observation');
    if (typeof observation.reason !== 'string' || observation.reason.length === 0 || observation.reason.length > 512) throw new TypeError('installation collection reason is invalid');
    collection = { status: 'unavailable', observedAt, reason: observation.reason };
  } else {
    object(observation, ['status', 'bytes'], 'installation transport observation');
    if (observation.status !== 'available') throw new TypeError('installation transport status is invalid');
    let report;
    try { report = decodeInstallerEvidence(observation.bytes, binding); }
    catch { collection = { status: 'invalid', observedAt, reason: 'installer evidence failed validation' }; }
    if (report) {
      const hash = digest(report);
      if (state.report && report.sequence < state.report.sequence) {
        collection = { status: 'stale', observedAt, reason: 'installer evidence sequence is older than the saved observation' };
      } else if (state.report && report.sequence === state.report.sequence && !sameOutcome(report, state.report)) {
        collection = { status: 'invalid', observedAt, reason: 'installer outcome changed at the saved sequence' };
      } else if (state.failure && (report.phase !== 'failed' || report.stage !== state.failure.stage || report.exitCode !== state.failure.exitCode)) {
        collection = { status: 'invalid', observedAt, reason: 'installer evidence contradicts the saved failure' };
      } else {
        state.report = report;
        state.reportSha256 = hash;
        state.reportObservedAt = observedAt;
        // Sequence identifies the installer outcome. Diagnostic reads enrich
        // that outcome independently; a small status replay has no log body.
        if (report.phase === 'failed' && (!state.failure || report.collection === 'complete' || state.failure.collection === 'unavailable')) {
          state.failure = report;
          state.failureSha256 = hash;
        }
        collection = { status: 'available', observedAt, reason: null };
      }
    }
  }
  return { protocol: CONSTRUCTION_INSTALL_EVIDENCE_PROTOCOL, binding, ...state, collection };
}
