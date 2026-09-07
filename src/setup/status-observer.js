const PROTOCOL = 'devbridge/status-observation-v1';
const STATES = new Set(['ready', 'unavailable', 'degraded']);
const MAX_REASON_BYTES = 1_024;

function capabilityStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('setup status capability observation is invalid');
  if (!STATES.has(raw.state) || typeof raw.ready !== 'boolean' || (raw.state === 'ready') !== raw.ready) {
    throw new TypeError('setup status capability observation is inconsistent');
  }
  if (!raw.ready && (typeof raw.reason !== 'string' || raw.reason.length === 0
      || Buffer.byteLength(raw.reason, 'utf8') > MAX_REASON_BYTES || /[\u0000-\u001f\u007f]/u.test(raw.reason))) {
    throw new TypeError('setup status unavailable capability requires a reason');
  }
  if (raw.ready && raw.reason != null) throw new TypeError('setup status ready capability cannot include a reason');
  return Object.freeze({
    state: raw.state,
    ready: raw.ready,
    reason: raw.ready ? null : raw.reason,
  });
}

export function createSetupStatusObserver({
  configuredSubjectCount,
  enabled,
  inspectCapability,
} = {}) {
  if (!Number.isSafeInteger(configuredSubjectCount) || configuredSubjectCount < 0) {
    throw new TypeError('setup status configured subject count must be a non-negative integer');
  }
  if (typeof enabled !== 'boolean') throw new TypeError('setup status enabled flag must be boolean');
  if (typeof inspectCapability !== 'function') throw new TypeError('setup status capability inspection port is required');

  return Object.freeze({
    async observe() {
      const execution = capabilityStatus(await inspectCapability());
      return Object.freeze({
        protocol: PROTOCOL,
        state: !enabled ? 'disabled' : execution.ready ? 'ready' : 'unavailable',
        enabled,
        configuredCount: configuredSubjectCount,
        capability: execution,
      });
    },
  });
}
