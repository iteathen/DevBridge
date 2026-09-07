const OBSERVATION_PROTOCOL = 'devbridge/setup-resource-conflict-v1';
const CONSENT_PROTOCOL = 'devbridge/setup-resource-conflict-consent-v1';
const RETIREMENT_PROTOCOL = 'devbridge/setup-resource-conflict-retirement-v1';
const SUBJECT = /^[0-9a-f]{64}$/u;
const STATES = new Set(['clear', 'approval-required', 'blocked']);

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function boundedReason(value, required, name) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('\0')) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export function normalizeSetupResourceConflictObservation(raw) {
  const value = exactObject(raw, new Set(['protocol', 'state', 'subject', 'reason']), 'setup resource conflict observation');
  if (value.protocol !== OBSERVATION_PROTOCOL || !STATES.has(value.state)) throw new TypeError('setup resource conflict observation is invalid');
  const requiresSubject = value.state === 'approval-required';
  if (requiresSubject !== (typeof value.subject === 'string' && SUBJECT.test(value.subject))) {
    throw new TypeError('setup resource conflict observation subject is invalid');
  }
  const reason = boundedReason(value.reason, value.state !== 'clear', 'setup resource conflict observation reason');
  return Object.freeze({ protocol: OBSERVATION_PROTOCOL, state: value.state, subject: requiresSubject ? value.subject : null, reason });
}

export function clearSetupResourceConflict() {
  return normalizeSetupResourceConflictObservation({ protocol: OBSERVATION_PROTOCOL, state: 'clear', subject: null, reason: null });
}

export function setupResourceConflictConsent(subject) {
  if (typeof subject !== 'string' || !SUBJECT.test(subject)) throw new TypeError('setup resource conflict consent subject is invalid');
  return Object.freeze({ protocol: CONSENT_PROTOCOL, subject });
}

export function normalizeSetupResourceConflictConsent(raw) {
  const value = exactObject(raw, new Set(['protocol', 'subject']), 'setup resource conflict consent');
  if (value.protocol !== CONSENT_PROTOCOL) throw new TypeError('setup resource conflict consent protocol is invalid');
  return setupResourceConflictConsent(value.subject);
}

export function setupResourceConflictRetirement({ ready, changed = false, reason = null } = {}) {
  if (typeof ready !== 'boolean' || typeof changed !== 'boolean') throw new TypeError('setup resource conflict retirement state is invalid');
  const bounded = boundedReason(reason, !ready, 'setup resource conflict retirement reason');
  return Object.freeze({ protocol: RETIREMENT_PROTOCOL, ready, changed, reason: bounded });
}

export function assertSetupResourceConflictPort(value) {
  if (!value || typeof value.inspect !== 'function' || typeof value.retire !== 'function') {
    throw new TypeError('setup resource conflict port is incomplete');
  }
  return value;
}

export function createClearSetupResourceConflictPort() {
  return Object.freeze({
    async inspect() { return clearSetupResourceConflict(); },
    async retire() {
      return setupResourceConflictRetirement({ ready: false, changed: false, reason: 'setup resource retirement is unavailable on this platform' });
    },
  });
}

export const SETUP_RESOURCE_CONFLICT_OBSERVATION_PROTOCOL = OBSERVATION_PROTOCOL;
export const SETUP_RESOURCE_CONFLICT_CONSENT_PROTOCOL = CONSENT_PROTOCOL;
export const SETUP_RESOURCE_CONFLICT_RETIREMENT_PROTOCOL = RETIREMENT_PROTOCOL;
