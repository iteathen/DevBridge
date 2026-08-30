export const COMPUTE_REQUIREMENT_PROTOCOL = 'devbridge/compute-requirement-v1';
export const COMPUTE_CAPABILITY_PROTOCOL = 'devbridge/compute-capability-v1';
export const COMPUTE_MATCH_PROTOCOL = 'devbridge/compute-capability-match-v1';

export const COMPUTE_CAPABILITY_STATUS = Object.freeze({
  QUALIFIED: 'qualified',
  UNKNOWN: 'unknown',
  UNSUPPORTED: 'unsupported',
});

export const COMPUTE_TOPOLOGY = Object.freeze({
  HOST_RETAINED: 'host-retained',
  EXCLUSIVE: 'exclusive',
  EMULATED_LOCAL: 'emulated-local',
  REMOTE: 'remote',
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const MAX_FEATURES = 256;
const MAX_EVIDENCE_CLAIMS = 64;

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

function optionalSafeId(value, name) {
  return value == null ? null : safeId(value, name);
}

function uniqueIds(raw, name, maximum) {
  if (!Array.isArray(raw) || raw.length > maximum) throw new TypeError(`${name} is invalid`);
  const values = raw.map((value, index) => safeId(value, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicates`);
  return Object.freeze([...values].sort());
}

function normalizeTopology(raw, name) {
  const topology = safeId(raw, name);
  if (!Object.values(COMPUTE_TOPOLOGY).includes(topology)) throw new TypeError(`${name} is unsupported`);
  return topology;
}

function normalizeEnvironment(raw, name) {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['identity', 'generation']), name);
  return Object.freeze({
    identity: safeId(value.identity, `${name}.identity`),
    generation: safeId(value.generation, `${name}.generation`),
  });
}

function normalizeQualification(raw) {
  const value = requireObject(raw, 'compute capability.qualification');
  onlyKeys(value, new Set(['identity', 'generation']), 'compute capability.qualification');
  return Object.freeze({
    identity: safeId(value.identity, 'compute capability.qualification.identity'),
    generation: safeId(value.generation, 'compute capability.qualification.generation'),
  });
}

export function normalizeComputeRequirement(raw) {
  const value = requireObject(raw, 'compute requirement');
  onlyKeys(value, new Set(['protocol', 'api', 'features', 'evidence', 'topology']), 'compute requirement');
  if (value.protocol !== COMPUTE_REQUIREMENT_PROTOCOL) throw new TypeError('compute requirement protocol is unsupported');
  return Object.freeze({
    protocol: COMPUTE_REQUIREMENT_PROTOCOL,
    api: safeId(value.api, 'compute requirement.api'),
    features: uniqueIds(value.features, 'compute requirement.features', MAX_FEATURES),
    evidence: uniqueIds(value.evidence, 'compute requirement.evidence', MAX_EVIDENCE_CLAIMS),
    topology: normalizeTopology(value.topology, 'compute requirement.topology'),
  });
}

export function normalizeComputeCapability(raw) {
  const value = requireObject(raw, 'compute capability');
  onlyKeys(value, new Set([
    'protocol', 'subject', 'generation', 'profile', 'environment', 'api', 'features', 'evidence',
    'topology', 'status', 'qualification', 'blocker',
  ]), 'compute capability');
  if (value.protocol !== COMPUTE_CAPABILITY_PROTOCOL) throw new TypeError('compute capability protocol is unsupported');
  if (!Object.values(COMPUTE_CAPABILITY_STATUS).includes(value.status)) throw new TypeError('compute capability.status is unsupported');

  const status = value.status;
  const qualification = value.qualification == null ? null : normalizeQualification(value.qualification);
  const blocker = optionalSafeId(value.blocker, 'compute capability.blocker');
  if (status === COMPUTE_CAPABILITY_STATUS.QUALIFIED) {
    if (qualification == null) throw new TypeError('qualified compute capability requires exact qualification evidence');
    if (blocker != null) throw new TypeError('qualified compute capability cannot carry a blocker');
  } else {
    if (qualification != null) throw new TypeError('non-qualified compute capability cannot carry qualification evidence');
    if (blocker == null) throw new TypeError('non-qualified compute capability requires an exact blocker');
  }

  return Object.freeze({
    protocol: COMPUTE_CAPABILITY_PROTOCOL,
    subject: safeId(value.subject, 'compute capability.subject'),
    generation: safeId(value.generation, 'compute capability.generation'),
    profile: safeId(value.profile, 'compute capability.profile'),
    environment: normalizeEnvironment(value.environment, 'compute capability.environment'),
    api: safeId(value.api, 'compute capability.api'),
    features: uniqueIds(value.features, 'compute capability.features', MAX_FEATURES),
    evidence: uniqueIds(value.evidence, 'compute capability.evidence', MAX_EVIDENCE_CLAIMS),
    topology: normalizeTopology(value.topology, 'compute capability.topology'),
    status,
    qualification,
    blocker,
  });
}

function normalizeExpectedContext(raw) {
  const value = requireObject(raw, 'compute match context');
  onlyKeys(value, new Set(['profile', 'environment']), 'compute match context');
  return Object.freeze({
    profile: safeId(value.profile, 'compute match context.profile'),
    environment: normalizeEnvironment(value.environment, 'compute match context.environment'),
  });
}

function missingMembers(required, available) {
  const present = new Set(available);
  return Object.freeze(required.filter((value) => !present.has(value)));
}

export function matchComputeCapability(rawRequirement, rawCapability, rawContext) {
  const requirement = normalizeComputeRequirement(rawRequirement);
  const capability = normalizeComputeCapability(rawCapability);
  const context = normalizeExpectedContext(rawContext);
  const missingFeatures = missingMembers(requirement.features, capability.features);
  const missingEvidence = missingMembers(requirement.evidence, capability.evidence);
  const mismatches = [];

  if (capability.status !== COMPUTE_CAPABILITY_STATUS.QUALIFIED) mismatches.push('capability-not-qualified');
  if (capability.profile !== context.profile) mismatches.push('profile');
  if (capability.environment.identity !== context.environment.identity) mismatches.push('environment-identity');
  if (capability.environment.generation !== context.environment.generation) mismatches.push('environment-generation');
  if (capability.api !== requirement.api) mismatches.push('api');
  if (capability.topology !== requirement.topology) mismatches.push('topology');

  const matched = mismatches.length === 0 && missingFeatures.length === 0 && missingEvidence.length === 0;
  return Object.freeze({
    protocol: COMPUTE_MATCH_PROTOCOL,
    matched,
    code: matched ? 'COMPUTE_REQUIREMENT_SATISFIED' : 'COMPUTE_REQUIREMENT_UNSATISFIED',
    requirement,
    capability,
    context,
    missing: Object.freeze({
      features: missingFeatures,
      evidence: missingEvidence,
    }),
    mismatches: Object.freeze(mismatches),
  });
}
