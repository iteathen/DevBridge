import { PolicyError } from '../errors.js';

export const TASK_LEASE_PROTOCOL = 'devbridge/task-lease-v1';
export const SIGNED_TASK_LEASE_PROTOCOL = 'devbridge/signed-task-lease-v1';

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const SHA_RE = /^[0-9a-f]{40}$/u;
const SESSION_RE = /^[0-9a-f]{32}$/u;
const ADDRESS_RE = /^([A-Za-z0-9_.-]{1,40})#([0-9a-f]{64})$/u;
const SUBJECT_KEYS = new Set([
  'protocol', 'queueRepository', 'issueNumber', 'taskRevision', 'ownerFingerprint', 'ownerAddress',
  'sessionId', 'epoch', 'state', 'issuedAt', 'expiresAt', 'previousLeaseSha',
]);
const ENVELOPE_KEYS = new Set(['protocol', 'subject', 'signature']);
const MAX_ENVELOPE_BYTES = 16 * 1024;

function exactIso(value, name) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 32) throw new PolicyError(`${name} must be a bounded ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new PolicyError(`${name} must be a canonical UTC ISO timestamp`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new PolicyError(`${name}.${key} is not allowed`);
}

export function normalizeTaskLeaseSubject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError('task lease subject must be an object');
  onlyKeys(raw, SUBJECT_KEYS, 'task lease subject');
  if (raw.protocol !== TASK_LEASE_PROTOCOL) throw new PolicyError('task lease protocol is unsupported');
  if (typeof raw.queueRepository !== 'string' || !REPOSITORY_RE.test(raw.queueRepository)) throw new PolicyError('task lease queueRepository must be owner/name');
  if (!Number.isSafeInteger(raw.issueNumber) || raw.issueNumber < 1) throw new PolicyError('task lease issueNumber must be a positive safe integer');
  if (typeof raw.taskRevision !== 'string' || !DIGEST_RE.test(raw.taskRevision)) throw new PolicyError('task lease taskRevision must be a lowercase SHA-256 digest');
  if (typeof raw.ownerFingerprint !== 'string' || !DIGEST_RE.test(raw.ownerFingerprint)) throw new PolicyError('task lease ownerFingerprint must be a lowercase SHA-256 digest');
  if (typeof raw.ownerAddress !== 'string' || !ADDRESS_RE.test(raw.ownerAddress)) throw new PolicyError('task lease ownerAddress is invalid');
  const address = ADDRESS_RE.exec(raw.ownerAddress);
  if (address[2] !== raw.ownerFingerprint) throw new PolicyError('task lease ownerAddress fingerprint does not match ownerFingerprint');
  if (typeof raw.sessionId !== 'string' || !SESSION_RE.test(raw.sessionId)) throw new PolicyError('task lease sessionId must be 16 random bytes encoded as lowercase hex');
  if (!Number.isSafeInteger(raw.epoch) || raw.epoch < 1) throw new PolicyError('task lease epoch must be a positive safe integer');
  if (!['active', 'released'].includes(raw.state)) throw new PolicyError('task lease state must be active or released');
  const issuedAt = exactIso(raw.issuedAt, 'task lease issuedAt');
  let expiresAt = null;
  if (raw.state === 'active') {
    expiresAt = exactIso(raw.expiresAt, 'task lease expiresAt');
    if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new PolicyError('task lease active expiry must be after issuance');
  } else if (raw.expiresAt !== null) {
    throw new PolicyError('released task lease expiresAt must be null');
  }
  const previousLeaseSha = raw.previousLeaseSha == null ? null : raw.previousLeaseSha;
  if (previousLeaseSha != null && (typeof previousLeaseSha !== 'string' || !SHA_RE.test(previousLeaseSha))) {
    throw new PolicyError('task lease previousLeaseSha must be null or a lowercase commit SHA');
  }
  return {
    protocol: TASK_LEASE_PROTOCOL,
    queueRepository: raw.queueRepository,
    issueNumber: raw.issueNumber,
    taskRevision: raw.taskRevision,
    ownerFingerprint: raw.ownerFingerprint,
    ownerAddress: raw.ownerAddress,
    sessionId: raw.sessionId,
    epoch: raw.epoch,
    state: raw.state,
    issuedAt,
    expiresAt,
    previousLeaseSha,
  };
}

export function canonicalTaskLeaseSubject(raw) {
  return JSON.stringify(normalizeTaskLeaseSubject(raw));
}

export function signTaskLease(identity, rawSubject) {
  if (!identity || typeof identity.sign !== 'function' || typeof identity.fingerprint !== 'string' || typeof identity.address !== 'string') {
    throw new TypeError('signTaskLease requires a local agent identity');
  }
  const subject = normalizeTaskLeaseSubject({
    ...rawSubject,
    protocol: TASK_LEASE_PROTOCOL,
    ownerFingerprint: identity.fingerprint,
    ownerAddress: identity.address,
  });
  return {
    protocol: SIGNED_TASK_LEASE_PROTOCOL,
    subject,
    signature: identity.sign(Buffer.from(JSON.stringify(subject), 'utf8')),
  };
}

export function serializeSignedTaskLease(envelope) {
  const verifiedShape = normalizeSignedTaskLeaseShape(envelope);
  return `${JSON.stringify(verifiedShape)}\n`;
}

export function parseSignedTaskLease(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') === 0 || Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES) {
    throw new PolicyError('signed task lease text must be non-empty and bounded');
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch (error) { throw new PolicyError('signed task lease is invalid JSON', { cause: error }); }
  return normalizeSignedTaskLeaseShape(raw);
}

function normalizeSignedTaskLeaseShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError('signed task lease envelope must be an object');
  onlyKeys(raw, ENVELOPE_KEYS, 'signed task lease envelope');
  if (raw.protocol !== SIGNED_TASK_LEASE_PROTOCOL) throw new PolicyError('signed task lease envelope protocol is unsupported');
  const subject = normalizeTaskLeaseSubject(raw.subject);
  if (typeof raw.signature !== 'string' || raw.signature.length < 80 || raw.signature.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(raw.signature)) {
    throw new PolicyError('signed task lease signature is invalid');
  }
  return { protocol: SIGNED_TASK_LEASE_PROTOCOL, subject, signature: raw.signature };
}

export function verifySignedTaskLease(envelope, { trustedIdentities, queueRepository, issueNumber, taskRevision }) {
  const normalized = normalizeSignedTaskLeaseShape(envelope);
  const subject = normalized.subject;
  if (subject.queueRepository !== queueRepository || subject.issueNumber !== issueNumber || subject.taskRevision !== taskRevision) {
    throw new PolicyError('signed task lease subject does not match the requested task revision');
  }
  const trusted = trustedIdentities instanceof Map
    ? trustedIdentities.get(subject.ownerFingerprint)
    : trustedIdentities?.[subject.ownerFingerprint];
  if (!trusted || typeof trusted.verify !== 'function') throw new PolicyError('signed task lease owner is not a locally trusted peer');
  if (trusted.fingerprint && trusted.fingerprint !== subject.ownerFingerprint) throw new PolicyError('trusted peer fingerprint mapping is inconsistent');
  if (trusted.address && trusted.address !== subject.ownerAddress) throw new PolicyError('signed task lease owner address does not match local peer policy');
  const payload = Buffer.from(JSON.stringify(subject), 'utf8');
  if (!trusted.verify(payload, normalized.signature)) throw new PolicyError('signed task lease signature verification failed');
  return normalized;
}

export function taskLeaseExpired(subject, nowMs, clockSkewMs = 0) {
  const normalized = normalizeTaskLeaseSubject(subject);
  if (normalized.state !== 'active') return true;
  if (!Number.isFinite(nowMs)) throw new TypeError('taskLeaseExpired nowMs must be finite');
  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) throw new TypeError('taskLeaseExpired clockSkewMs must be a non-negative safe integer');
  return nowMs > Date.parse(normalized.expiresAt) + clockSkewMs;
}
