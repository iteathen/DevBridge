const PROTOCOL = 'devbridge/setup-status-operation-v1';
const OBSERVATION_PROTOCOL = 'devbridge/status-observation-v1';
const STATES = new Set(['ready', 'disabled', 'unavailable']);
const CAPABILITY_STATES = new Set(['ready', 'unavailable', 'degraded']);
const MAX_REASON_BYTES = 1_024;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^;\r\n]*/gu;
const UNC_PATH = /\\\\[^\\\s;]+\\[^;\r\n]*/gu;
const POSIX_HOME_PATH = /\/(?:home|Users|tmp|var\/tmp)\/[^;\r\n]*/gu;
const SLASHED_TOKEN = /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/gu;

function observedResult(stdout, stderr = '', exitCode = 0) {
  const now = new Date().toISOString();
  return Object.freeze({
    exitCode,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    stdout,
    stderr,
    startedAt: now,
    finishedAt: now,
    lastOutputAt: stdout || stderr ? now : null,
  });
}

function paramsOnly(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('setup.status params must be an object');
  if (Object.keys(raw).length !== 0) throw new TypeError('setup.status accepts no parameters');
  return Object.freeze({});
}

function remoteReason(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value
    .replace(WINDOWS_PATH, '<local-path>')
    .replace(UNC_PATH, '<local-path>')
    .replace(POSIX_HOME_PATH, '<local-path>')
    .replace(SLASHED_TOKEN, '<identifier>')
    .slice(0, 4096);
}

function boundedReason(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_REASON_BYTES
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('setup status capability reason is invalid');
  }
  return remoteReason(value);
}

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function capabilityProjection(raw) {
  const value = exactObject(raw, new Set(['state', 'ready', 'reason']), 'setup status capability');
  if (!CAPABILITY_STATES.has(value.state) || typeof value.ready !== 'boolean' || (value.state === 'ready') !== value.ready) {
    throw new TypeError('setup status capability is inconsistent');
  }
  if (value.ready && value.reason != null) throw new TypeError('setup status ready capability cannot include a reason');
  const reason = value.ready ? null : boundedReason(value.reason);
  return Object.freeze({ state: value.state, ready: value.ready, reason });
}

export function projectSetupObservation(raw) {
  const value = exactObject(raw, new Set(['protocol', 'state', 'enabled', 'configuredCount', 'capability']), 'setup status observation');
  if (value.protocol !== OBSERVATION_PROTOCOL) throw new TypeError('setup status observation protocol is unsupported');
  if (!STATES.has(value.state) || typeof value.enabled !== 'boolean') throw new TypeError('setup status observation state is invalid');
  if (!Number.isSafeInteger(value.configuredCount) || value.configuredCount < 0) throw new TypeError('setup status configured count is invalid');
  const capability = capabilityProjection(value.capability);
  const expected = !value.enabled ? 'disabled' : capability.ready ? 'ready' : 'unavailable';
  if (value.state !== expected) throw new TypeError('setup status observation state is inconsistent');
  return Object.freeze({
    protocol: PROTOCOL,
    state: value.state,
    ready: value.state === 'ready',
    blocked: value.state === 'unavailable',
    enabled: value.enabled,
    configuredCount: value.configuredCount,
    capability,
  });
}

export function createSetupStatusOperation({ observeSetup } = {}) {
  if (typeof observeSetup !== 'function') throw new TypeError('setup.status requires a setup observer');
  return Object.freeze({
    layer: 'setup',
    publicSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    validate: paramsOnly,
    async execute() {
      try {
        const projected = projectSetupObservation(await observeSetup());
        return observedResult(`${JSON.stringify(projected)}\n`);
      } catch (error) {
        return observedResult('', `setup.status failed: ${remoteReason(error?.message) ?? 'unknown failure'}\n`, 1);
      }
    },
  });
}

export { PROTOCOL as SETUP_STATUS_OPERATION_PROTOCOL };
