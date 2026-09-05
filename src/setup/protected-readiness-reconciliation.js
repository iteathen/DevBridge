const OBSERVATION_PROTOCOL = 'devbridge/protected-readiness-observation-v1';
const RECONCILIATION_PROTOCOL = 'devbridge/protected-readiness-reconciliation-v1';
const DIGEST = /^[0-9a-f]{64}$/u;
const REASON = /^[a-z][a-z0-9-]{0,63}$/u;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function generation(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError('protected readiness generation is invalid');
  return value;
}

function reason(value, { required }) {
  if (!required && value == null) return null;
  if (typeof value !== 'string' || !REASON.test(value)) throw new TypeError('protected readiness reason is invalid');
  return value;
}

export function createProtectedReadinessObservation({ ready, subject, generation: rawGeneration, reason: rawReason } = {}) {
  if (typeof ready !== 'boolean') throw new TypeError('protected readiness state is invalid');
  const selectedGeneration = generation(rawGeneration);
  const selectedReason = reason(rawReason, { required: !ready });
  if (ready) {
    if (subject != null || selectedGeneration == null || selectedReason != null) {
      throw new TypeError('ready protected readiness evidence is inconsistent');
    }
  } else if (subject != null && (!subject || typeof subject !== 'object' || Array.isArray(subject) || !Object.isFrozen(subject))) {
    throw new TypeError('protected readiness subject is invalid');
  }
  return Object.freeze({
    protocol: OBSERVATION_PROTOCOL,
    ready,
    subject: subject ?? null,
    generation: selectedGeneration,
    reason: selectedReason,
  });
}

function normalizeObservation(value) {
  exactKeys(value, new Set(['protocol', 'ready', 'subject', 'generation', 'reason']), 'protected readiness observation');
  if (value.protocol !== OBSERVATION_PROTOCOL) throw new TypeError('protected readiness observation protocol is invalid');
  return createProtectedReadinessObservation(value);
}

function result({ ready, attempted, generation: selectedGeneration, reason: selectedReason }) {
  return Object.freeze({
    protocol: RECONCILIATION_PROTOCOL,
    ready,
    attempted,
    generation: selectedGeneration,
    reason: selectedReason,
  });
}

function unavailable(reasonValue, { attempted = false, generation: selectedGeneration = null } = {}) {
  return result({ ready: false, attempted, generation: selectedGeneration, reason: reasonValue });
}

export async function reconcileProtectedReadiness(value = {}) {
  exactKeys(value, new Set(['observe', 'attempt']), 'protected readiness reconciliation');
  if (typeof value.observe !== 'function' || typeof value.attempt !== 'function') {
    throw new TypeError('protected readiness reconciliation ports are invalid');
  }

  let first;
  try { first = normalizeObservation(await value.observe()); }
  catch { return unavailable('observation-invalid'); }
  if (first.ready) return result({ ready: true, attempted: false, generation: first.generation, reason: null });
  if (first.subject == null) return unavailable(first.reason, { generation: first.generation });

  try { await value.attempt(first.subject); }
  catch {}

  let second;
  try { second = normalizeObservation(await value.observe()); }
  catch { return unavailable('observation-invalid', { attempted: true }); }
  if (second.ready) return result({ ready: true, attempted: true, generation: second.generation, reason: null });
  return unavailable(second.reason, { attempted: true, generation: second.generation });
}

export {
  OBSERVATION_PROTOCOL as PROTECTED_READINESS_OBSERVATION_PROTOCOL,
  RECONCILIATION_PROTOCOL as PROTECTED_READINESS_RECONCILIATION_PROTOCOL,
};
