export const LOCAL_LIVENESS_PROTOCOL = 'devbridge/local-liveness-v1';

const PHASE = /^[a-z][a-z0-9-]{0,31}$/u;

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeProgress(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('local liveness progress is invalid');
  if (typeof raw.phase !== 'string' || !PHASE.test(raw.phase)) throw new TypeError('local liveness phase is invalid');
  const completed = nonNegativeInteger(raw.completed ?? 0, 'local liveness completed count');
  const total = raw.total == null ? null : nonNegativeInteger(raw.total, 'local liveness total count');
  const attempt = nonNegativeInteger(raw.attempt ?? 0, 'local liveness attempt count');
  if (total != null && completed > total) throw new TypeError('local liveness completed count exceeds total');
  return Object.freeze({ phase: raw.phase, completed, total, attempt });
}

function readClock(now, fallback) {
  try {
    const value = now();
    return Number.isFinite(value) ? Math.trunc(value) : fallback;
  } catch {
    return fallback;
  }
}

export function createLocalLiveness({
  output,
  intervalMs = 15_000,
  now = Date.now,
  schedule = setInterval,
  cancel = clearInterval,
} = {}) {
  if (!output || typeof output.write !== 'function') throw new TypeError('local liveness output is incomplete');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60_000) throw new TypeError('local liveness interval is invalid');
  if (typeof now !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function') throw new TypeError('local liveness timing contract is incomplete');

  let progress = normalizeProgress({ phase: 'starting' });
  let startedAt = 0;
  let timer = null;
  let active = false;
  let writable = true;

  const emit = () => {
    if (!active || !writable) return;
    const observedAt = readClock(now, startedAt);
    const record = Object.freeze({
      protocol: LOCAL_LIVENESS_PROTOCOL,
      phase: progress.phase,
      elapsedMs: Math.max(0, observedAt - startedAt),
      completed: progress.completed,
      total: progress.total,
      attempt: progress.attempt,
    });
    try {
      if (output.write(`[devbridge-liveness] ${JSON.stringify(record)}\n`) === false) writable = false;
    } catch {
      writable = false;
    }
  };

  return Object.freeze({
    update(raw) {
      try { progress = normalizeProgress(raw); } catch { /* Observability has no operation authority. */ }
    },
    start() {
      if (active) return;
      active = true;
      startedAt = readClock(now, 0);
      emit();
      try {
        timer = schedule(emit, intervalMs);
        timer?.unref?.();
      } catch {
        timer = null;
      }
    },
    stop() {
      if (!active) return;
      active = false;
      if (timer != null) {
        try { cancel(timer); } catch { /* Observability has no operation authority. */ }
        timer = null;
      }
    },
  });
}

export async function runWithLocalLiveness(operation, options) {
  if (typeof operation !== 'function') throw new TypeError('local liveness operation is required');
  const liveness = createLocalLiveness(options);
  liveness.start();
  try {
    return await operation((progress) => liveness.update(progress));
  } finally {
    liveness.stop();
  }
}
