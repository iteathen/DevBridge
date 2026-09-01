const PROTOCOL = 'devbridge/setup-progress-v1';
const PHASE = /^[a-z][a-z0-9-]{0,79}$/u;

function boundedDetail(value) {
  if (value == null) return null;
  const text = String(value).replace(/[\r\n]+/gu, ' ').trim();
  return text.length === 0 ? null : text.slice(0, 240);
}

export function createSetupProgress({ onProgress = null, clock = () => Date.now() } = {}) {
  if (onProgress != null && typeof onProgress !== 'function') throw new TypeError('setup progress port is invalid');
  if (typeof clock !== 'function') throw new TypeError('setup progress clock is invalid');
  const startedAt = clock();
  let sequence = 0;

  function emit(phase, state, detail = null) {
    if (typeof phase !== 'string' || !PHASE.test(phase)) throw new TypeError('setup progress phase is invalid');
    const elapsedMilliseconds = Math.max(0, clock() - startedAt);
    const event = Object.freeze({
      protocol: PROTOCOL,
      sequence: sequence += 1,
      phase,
      state,
      elapsedMilliseconds,
      detail: boundedDetail(detail),
    });
    try { onProgress?.(event); } catch {}
    return event;
  }

  return Object.freeze({
    emit,
    async run(phase, operation, detail = null) {
      if (typeof operation !== 'function') throw new TypeError('setup progress operation is invalid');
      emit(phase, 'started', detail);
      try {
        const value = await operation();
        emit(phase, 'completed');
        return value;
      } catch (error) {
        emit(phase, 'failed', error?.message ?? error);
        throw error;
      }
    },
    async watch(phase, operation, { intervalMilliseconds = 15_000, detail = 'operation remains active' } = {}) {
      if (typeof operation !== 'function') throw new TypeError('setup watched operation is invalid');
      if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 1_000 || intervalMilliseconds > 60_000) {
        throw new TypeError('setup watched operation interval is invalid');
      }
      emit(phase, 'started');
      const timer = setInterval(() => emit(phase, 'active', detail), intervalMilliseconds);
      timer.unref?.();
      try {
        const value = await operation();
        emit(phase, 'completed');
        return value;
      } catch (error) {
        emit(phase, 'failed', error?.message ?? error);
        throw error;
      } finally {
        clearInterval(timer);
      }
    },
  });
}

export function formatSetupProgress(event) {
  if (!event || event.protocol !== PROTOCOL) throw new TypeError('setup progress event is invalid');
  const seconds = Math.floor(event.elapsedMilliseconds / 1000);
  const detail = event.detail == null ? '' : ` — ${event.detail}`;
  return `[setup ${seconds}s] ${event.phase}: ${event.state}${detail}\n`;
}

export { PROTOCOL as SETUP_PROGRESS_PROTOCOL };
