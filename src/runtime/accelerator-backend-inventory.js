import { COMPUTE_TOPOLOGY } from './compute-capabilities.js';

export const ACCELERATOR_BACKEND_OBSERVATION_PROTOCOL = 'devbridge/accelerator-backend-observation-v1';
export const ACCELERATOR_BACKEND_INVENTORY_PROTOCOL = 'devbridge/accelerator-backend-inventory-v1';

export const ACCELERATOR_BACKEND_DISPOSITION = Object.freeze({
  CANDIDATE: 'candidate',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
});

export const ACCELERATOR_BACKEND_CHECK_STATE = Object.freeze({
  READY: 'ready',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
});

export const ACCELERATOR_BACKEND_CHECK = Object.freeze({
  HOST_PLATFORM: 'hostPlatform',
  BACKEND_RUNTIME: 'backendRuntime',
  BACKEND_ENVIRONMENT: 'backendEnvironment',
  ACCELERATOR_RUNTIME: 'acceleratorRuntime',
  BOUNDARY_TRANSPORT: 'boundaryTransport',
  SECURITY_BOUNDARY: 'securityBoundary',
});

export const ACCELERATOR_BACKEND_REASON = Object.freeze({
  PLATFORM_UNSUPPORTED: 'platform-unsupported',
  PLATFORM_OBSERVATION_FAILED: 'platform-observation-failed',
  RUNTIME_UNAVAILABLE: 'runtime-unavailable',
  RUNTIME_OBSERVATION_FAILED: 'runtime-observation-failed',
  ENVIRONMENT_UNAVAILABLE: 'environment-unavailable',
  ENVIRONMENT_OBSERVATION_FAILED: 'environment-observation-failed',
  ACCELERATOR_UNAVAILABLE: 'accelerator-unavailable',
  ACCELERATOR_INCOMPATIBLE: 'accelerator-incompatible',
  ACCELERATOR_OBSERVATION_FAILED: 'accelerator-observation-failed',
  TRANSPORT_UNPROVEN: 'transport-unproven',
  TRANSPORT_UNAVAILABLE: 'transport-unavailable',
  SECURITY_UNPROVEN: 'security-unproven',
  SECURITY_BLOCKED: 'security-blocked',
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const CHECK_ORDER = Object.freeze(Object.values(ACCELERATOR_BACKEND_CHECK));
const ESSENTIAL_CHECKS = new Set([
  ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM,
  ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME,
  ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT,
  ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME,
]);
const MAX_BACKEND_OBSERVATIONS = 8;

const REASON_RULES = Object.freeze({
  [ACCELERATOR_BACKEND_REASON.PLATFORM_UNSUPPORTED]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM, state: ACCELERATOR_BACKEND_CHECK_STATE.BLOCKED }),
  [ACCELERATOR_BACKEND_REASON.PLATFORM_OBSERVATION_FAILED]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM, state: ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN }),
  [ACCELERATOR_BACKEND_REASON.RUNTIME_UNAVAILABLE]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME, state: ACCELERATOR_BACKEND_CHECK_STATE.BLOCKED }),
  [ACCELERATOR_BACKEND_REASON.RUNTIME_OBSERVATION_FAILED]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME, state: ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN }),
  [ACCELERATOR_BACKEND_REASON.ENVIRONMENT_UNAVAILABLE]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT, state: ACCELERATOR_BACKEND_CHECK_STATE.BLOCKED }),
  [ACCELERATOR_BACKEND_REASON.ENVIRONMENT_OBSERVATION_FAILED]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT, state: ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN }),
  [ACCELERATOR_BACKEND_REASON.ACCELERATOR_UNAVAILABLE]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME, state: ACCELERATOR_BACKEND_CHECK_STATE.BLOCKED }),
  [ACCELERATOR_BACKEND_REASON.ACCELERATOR_INCOMPATIBLE]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME, state: ACCELERATOR_BACKEND_CHECK_STATE.BLOCKED }),
  [ACCELERATOR_BACKEND_REASON.ACCELERATOR_OBSERVATION_FAILED]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME, state: ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN }),
  [ACCELERATOR_BACKEND_REASON.TRANSPORT_UNPROVEN]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.BOUNDARY_TRANSPORT, state: ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN }),
  [ACCELERATOR_BACKEND_REASON.TRANSPORT_UNAVAILABLE]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.BOUNDARY_TRANSPORT, state: ACCELERATOR_BACKEND_CHECK_STATE.BLOCKED }),
  [ACCELERATOR_BACKEND_REASON.SECURITY_UNPROVEN]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.SECURITY_BOUNDARY, state: ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN }),
  [ACCELERATOR_BACKEND_REASON.SECURITY_BLOCKED]: Object.freeze({ check: ACCELERATOR_BACKEND_CHECK.SECURITY_BOUNDARY, state: ACCELERATOR_BACKEND_CHECK_STATE.BLOCKED }),
});

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function topology(value) {
  if (!Object.values(COMPUTE_TOPOLOGY).includes(value)) throw new TypeError('accelerator backend observation.topology is unsupported');
  return value;
}

function normalizeCheck(raw, check) {
  const value = requireObject(raw, `accelerator backend observation.checks.${check}`);
  onlyKeys(value, new Set(['state', 'reason']), `accelerator backend observation.checks.${check}`);
  if (!Object.values(ACCELERATOR_BACKEND_CHECK_STATE).includes(value.state)) {
    throw new TypeError(`accelerator backend observation.checks.${check}.state is unsupported`);
  }
  if (value.state === ACCELERATOR_BACKEND_CHECK_STATE.READY) {
    if (value.reason != null) throw new TypeError(`ready accelerator backend check ${check} cannot carry a reason`);
    return Object.freeze({ state: value.state, reason: null });
  }
  const reason = safeId(value.reason, `accelerator backend observation.checks.${check}.reason`);
  const rule = REASON_RULES[reason];
  if (!rule || rule.check !== check || rule.state !== value.state) {
    throw new TypeError(`accelerator backend observation.checks.${check}.reason is inconsistent with its check/state`);
  }
  return Object.freeze({ state: value.state, reason });
}

function normalizeChecks(raw) {
  const value = requireObject(raw, 'accelerator backend observation.checks');
  onlyKeys(value, new Set(CHECK_ORDER), 'accelerator backend observation.checks');
  const result = {};
  for (const check of CHECK_ORDER) {
    if (!(check in value)) throw new TypeError(`accelerator backend observation.checks.${check} is required`);
    result[check] = normalizeCheck(value[check], check);
  }
  return Object.freeze(result);
}

function codePointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deriveAcceleratorBackendDisposition(checks) {
  const normalized = normalizeChecks(checks);
  if (CHECK_ORDER.some((check) => normalized[check].state === ACCELERATOR_BACKEND_CHECK_STATE.BLOCKED)) {
    return ACCELERATOR_BACKEND_DISPOSITION.BLOCKED;
  }
  if ([...ESSENTIAL_CHECKS].some((check) => normalized[check].state === ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN)) {
    return ACCELERATOR_BACKEND_DISPOSITION.UNKNOWN;
  }
  return ACCELERATOR_BACKEND_DISPOSITION.CANDIDATE;
}

export function normalizeAcceleratorBackendObservation(raw) {
  const value = requireObject(raw, 'accelerator backend observation');
  onlyKeys(value, new Set(['protocol', 'subject', 'generation', 'api', 'topology', 'disposition', 'checks']), 'accelerator backend observation');
  if (value.protocol !== ACCELERATOR_BACKEND_OBSERVATION_PROTOCOL) throw new TypeError('accelerator backend observation protocol is unsupported');
  if (!Object.values(ACCELERATOR_BACKEND_DISPOSITION).includes(value.disposition)) throw new TypeError('accelerator backend observation.disposition is unsupported');
  const checks = normalizeChecks(value.checks);
  const expected = deriveAcceleratorBackendDisposition(checks);
  if (value.disposition !== expected) throw new TypeError('accelerator backend observation.disposition does not match its checks');
  return Object.freeze({
    protocol: ACCELERATOR_BACKEND_OBSERVATION_PROTOCOL,
    subject: safeId(value.subject, 'accelerator backend observation.subject'),
    generation: safeId(value.generation, 'accelerator backend observation.generation'),
    api: safeId(value.api, 'accelerator backend observation.api'),
    topology: topology(value.topology),
    disposition: expected,
    checks,
  });
}

export function createAcceleratorBackendObservation({ subject, generation, api, topology: requestedTopology, checks }) {
  return normalizeAcceleratorBackendObservation({
    protocol: ACCELERATOR_BACKEND_OBSERVATION_PROTOCOL,
    subject,
    generation,
    api,
    topology: requestedTopology,
    disposition: deriveAcceleratorBackendDisposition(checks),
    checks,
  });
}

export function normalizeAcceleratorBackendInventory(raw) {
  const value = requireObject(raw, 'accelerator backend inventory');
  onlyKeys(value, new Set(['protocol', 'observations']), 'accelerator backend inventory');
  if (value.protocol !== ACCELERATOR_BACKEND_INVENTORY_PROTOCOL) throw new TypeError('accelerator backend inventory protocol is unsupported');
  if (!Array.isArray(value.observations) || value.observations.length < 1 || value.observations.length > MAX_BACKEND_OBSERVATIONS) {
    throw new TypeError('accelerator backend inventory.observations is invalid');
  }
  const observations = value.observations.map((entry) => normalizeAcceleratorBackendObservation(entry));
  const subjects = observations.map((entry) => entry.subject);
  if (new Set(subjects).size !== subjects.length) throw new TypeError('accelerator backend inventory contains duplicate subjects');
  observations.sort((left, right) => codePointCompare(left.subject, right.subject));
  return Object.freeze({
    protocol: ACCELERATOR_BACKEND_INVENTORY_PROTOCOL,
    observations: Object.freeze(observations),
  });
}

export function createAcceleratorBackendInventory(observations) {
  return normalizeAcceleratorBackendInventory({
    protocol: ACCELERATOR_BACKEND_INVENTORY_PROTOCOL,
    observations,
  });
}
