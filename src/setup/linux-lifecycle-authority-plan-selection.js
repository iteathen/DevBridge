import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import {
  createLinuxLifecycleAuthorityPlan,
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from './linux-lifecycle-authority.js';
import {
  LINUX_PROVIDER_AUTHORITY_PREFLIGHT_PROTOCOL,
  observeLinuxProviderAuthorityPreflight,
} from './linux-provider-authority-preflight.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-plan-selection-v1';
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const BOUNDED_REASON = /^[a-z][a-z0-9-]{0,63}$/u;
const PLATFORM = /^[a-z][a-z0-9_-]{0,31}$/u;
const MAX_CAPABILITIES = 16;
const PLAN_KEYS = new Set([
  'protocol',
  'authorityIdentity',
  'stateDirectory',
  'storage',
  'protectedRoot',
  'authorityDirectory',
  'ownershipManifest',
  'refreshJournal',
  'runtimeEvidence',
  'runtime',
  'service',
  'coordination',
  'configuration',
  'activity',
  'endpoints',
  'access',
]);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function absoluteState(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value) || !path.posix.isAbsolute(value)) {
    throw new TypeError('Linux authority plan selection stateDirectory is invalid');
  }
  return path.posix.resolve(value);
}

function principalName(value) {
  if (typeof value !== 'string' || !LOCAL_NAME.test(value)) {
    throw new TypeError('Linux authority plan selection principal is invalid');
  }
  return value;
}

function capability(value, name) {
  exactKeys(value, new Set(['name', 'id']), name);
  if (typeof value.name !== 'string' || !LOCAL_NAME.test(value.name)) throw new Error(`${name} name is invalid`);
  if (!Number.isSafeInteger(value.id) || value.id < 1) throw new Error(`${name} id is invalid`);
  return Object.freeze({ name: value.name, id: value.id });
}

function eligibilityEvidence(value) {
  exactKeys(value, new Set([
    'protocol',
    'platform',
    'applicable',
    'observable',
    'exact',
    'separation',
    'selectedCapability',
    'capabilities',
    'reason',
  ]), 'Linux authority plan selection eligibility evidence');
  if (value.protocol !== LINUX_PROVIDER_AUTHORITY_PREFLIGHT_PROTOCOL
      || value.platform !== 'linux'
      || value.applicable !== true
      || typeof value.observable !== 'boolean'
      || typeof value.exact !== 'boolean'
      || !['verified', 'unverified'].includes(value.separation)
      || !Array.isArray(value.capabilities)
      || value.capabilities.length > MAX_CAPABILITIES) {
    throw new Error('Linux authority plan selection eligibility evidence is invalid');
  }
  const capabilities = Object.freeze(value.capabilities.map((entry, index) => capability(entry, `Linux authority plan selection capability ${index}`)));
  if (new Set(capabilities.map((entry) => entry.name)).size !== capabilities.length
      || new Set(capabilities.map((entry) => entry.id)).size !== capabilities.length) {
    throw new Error('Linux authority plan selection capabilities alias');
  }
  if (value.exact !== true) {
    if (value.separation !== 'unverified' || value.selectedCapability !== null
        || typeof value.reason !== 'string' || !BOUNDED_REASON.test(value.reason)) {
      throw new Error('Linux authority plan selection unavailable evidence is invalid');
    }
    return Object.freeze({ ready: false, selected: null });
  }
  if (value.observable !== true || value.separation !== 'verified' || value.reason !== null || capabilities.length === 0) {
    throw new Error('Linux authority plan selection verified evidence is invalid');
  }
  const selected = capability(value.selectedCapability, 'Linux authority plan selection selected capability');
  if (!capabilities.some((entry) => entry.name === selected.name && entry.id === selected.id)) {
    throw new Error('Linux authority plan selection selected capability is not observed');
  }
  return Object.freeze({ ready: true, selected });
}

function unavailable(platform, reason) {
  return Object.freeze({
    protocol: PROTOCOL,
    platform,
    applicable: platform === 'linux',
    ready: false,
    reason,
    plan: null,
  });
}

function canonicalPlan({ stateDirectory, principal, capability }) {
  return createLinuxLifecycleAuthorityPlan({
    stateDirectory,
    operatorName: principal,
    managementGroup: capability.name,
  });
}

function exactPlan(value, request) {
  try { exactKeys(value, PLAN_KEYS, 'Linux authority selected plan'); }
  catch { return null; }
  let expected;
  try { expected = canonicalPlan(request); }
  catch { return null; }
  if (value.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL || !isDeepStrictEqual(value, expected)) return null;
  return expected;
}

export async function selectLinuxLifecycleAuthorityPlan(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['stateDirectory', 'principal']), 'Linux authority plan selection request');
  exactKeys(providedPorts, new Set(['readPlatform', 'observeEligibility', 'projectPlan']), 'Linux authority plan selection ports');
  const request = Object.freeze({
    stateDirectory: absoluteState(value.stateDirectory),
    principal: principalName(value.principal),
  });
  const ports = Object.freeze({
    readPlatform: providedPorts.readPlatform ?? (() => process.platform),
    observeEligibility: providedPorts.observeEligibility ?? observeLinuxProviderAuthorityPreflight,
    projectPlan: providedPorts.projectPlan ?? canonicalPlan,
  });
  if (Object.values(ports).some((port) => typeof port !== 'function')) {
    throw new TypeError('Linux authority plan selection ports are invalid');
  }

  let platform;
  try { platform = await ports.readPlatform(); }
  catch { return unavailable(null, 'platform-observation-unavailable'); }
  if (typeof platform !== 'string' || !PLATFORM.test(platform)) return unavailable(null, 'platform-evidence-invalid');
  if (platform !== 'linux') return unavailable(platform, 'not-applicable');

  let eligibility;
  try {
    eligibility = eligibilityEvidence(await ports.observeEligibility({ principal: request.principal, platform: 'linux' }));
  } catch {
    return unavailable('linux', 'eligibility-evidence-invalid');
  }
  if (!eligibility.ready) return unavailable('linux', 'eligibility-unverified');

  const projectionRequest = Object.freeze({ ...request, capability: eligibility.selected });
  let projected;
  try { projected = await ports.projectPlan(projectionRequest); }
  catch { return unavailable('linux', 'plan-projection-unavailable'); }
  const plan = exactPlan(projected, projectionRequest);
  if (!plan) return unavailable('linux', 'plan-evidence-invalid');
  return Object.freeze({
    protocol: PROTOCOL,
    platform: 'linux',
    applicable: true,
    ready: true,
    reason: null,
    plan,
  });
}

export { PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_PLAN_SELECTION_PROTOCOL };
