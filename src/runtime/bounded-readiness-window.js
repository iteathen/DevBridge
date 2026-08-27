const MAX_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

function duration(value, minimum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_MILLISECONDS) throw new TypeError(`${name} is invalid`);
  return value;
}

function instant(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('readiness observation clock is invalid');
  return value.getTime();
}

export function observeBoundedReadiness({
  elapsedMilliseconds,
  observedAt,
  expectedMilliseconds,
  deadlineMilliseconds,
  recheckMilliseconds,
} = {}) {
  const elapsed = duration(elapsedMilliseconds, 0, 'readiness elapsedMilliseconds');
  const expected = duration(expectedMilliseconds, 1, 'readiness expectedMilliseconds');
  const deadline = duration(deadlineMilliseconds, 1, 'readiness deadlineMilliseconds');
  const recheck = duration(recheckMilliseconds, 1, 'readiness recheckMilliseconds');
  if (expected > deadline || recheck > deadline) throw new TypeError('readiness policy ordering is invalid');
  const observed = instant(observedAt);
  const started = observed - elapsed;
  const classification = elapsed >= deadline ? 'expired' : elapsed >= expected ? 'slow' : 'observing';
  const nextObservationAt = classification === 'expired'
    ? null
    : new Date(Math.min(observed + recheck, started + deadline)).toISOString();
  return Object.freeze({
    classification,
    elapsedMilliseconds: elapsed,
    observedAt: new Date(observed).toISOString(),
    startedAt: new Date(started).toISOString(),
    expectedAt: new Date(started + expected).toISOString(),
    hardDeadlineAt: new Date(started + deadline).toISOString(),
    nextObservationAt,
  });
}
