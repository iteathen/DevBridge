import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import {
  bindLinuxLifecycleAuthorityRuntime,
  createLinuxLifecycleAuthorityPlan,
} from './linux-lifecycle-authority.js';
import {
  createLinuxLifecycleAuthorityRefreshComposition,
  LINUX_LIFECYCLE_AUTHORITY_REFRESH_COMPOSITION_PROTOCOL,
} from './linux-lifecycle-authority-refresh-composition.js';
import { reconcileLinuxLifecycleAuthorityRefresh } from './linux-lifecycle-authority-refresh-adapter.js';
import { LINUX_LOCAL_IDENTITIES_PROTOCOL, observeLinuxLocalIdentities } from './linux-local-identities.js';
import {
  LINUX_LOCAL_STATE_IDENTITY_PROTOCOL,
  observeLinuxLocalStateIdentity,
} from './linux-local-state-identity.js';
import {
  LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL,
  observeLinuxProviderManagementTopology,
} from './linux-provider-management-topology.js';
import { measureProtectedAuthorityRuntimeCandidate } from './protected-authority-runtime-candidate.js';
import { PROTECTED_AUTHORITY_RECONCILIATION_PROTOCOL } from './protected-authority-reconciliation.js';
import {
  createProtectedRefreshChildResult,
  normalizeProtectedRefreshChildOrigin,
  normalizeProtectedRefreshChildRequest,
} from './protected-refresh-child-contract.js';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const MAX_LOCAL_ID = 0xffff_fffe;
const TOPOLOGY_KEYS = new Set([
  'protocol',
  'platform',
  'applicable',
  'observable',
  'exact',
  'classification',
  'route',
  'selectedCapability',
  'capabilities',
  'subjects',
  'reason',
]);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function exactStateIdentity(value) {
  if (!path.posix.isAbsolute(value) || path.posix.resolve(value) !== value || value === '/' || path.posix.basename(value) !== 'state') {
    throw new TypeError('Linux protected refresh child state identity is invalid');
  }
  return value;
}

function exactStateEvidence(value, stateIdentity, principal) {
  exactKeys(value, new Set(['protocol', 'identity', 'ownerId']), 'Linux protected refresh child state evidence');
  if (value.protocol !== LINUX_LOCAL_STATE_IDENTITY_PROTOCOL || value.identity !== stateIdentity || value.ownerId !== principal.identityId) {
    throw new Error('Linux protected refresh child state identity changed');
  }
  return stateIdentity;
}

function localCapability(value, name) {
  exactKeys(value, new Set(['name', 'id']), name);
  if (typeof value.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u.test(value.name)
      || !Number.isSafeInteger(value.id) || value.id < 1 || value.id > MAX_LOCAL_ID) {
    throw new Error(`${name} is invalid`);
  }
  return Object.freeze({ name: value.name, id: value.id });
}

function sameCapability(left, right) {
  return left.name === right.name && left.id === right.id;
}

function selectedTopology(value, required) {
  exactKeys(value, TOPOLOGY_KEYS, 'Linux protected refresh child topology');
  if (value.protocol !== LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL || value.platform !== 'linux'
      || value.applicable !== true || value.observable !== true || value.exact !== true
      || value.classification !== 'group-only' || value.reason !== null || !Array.isArray(value.capabilities)
      || !Array.isArray(value.subjects) || value.capabilities.length < 1 || value.capabilities.length > 16) {
    throw new Error('Linux protected refresh child topology is unavailable');
  }
  if (!['segmented', 'combined'].includes(value.route)) throw new Error('Linux protected refresh child topology route is invalid');
  const capabilities = value.capabilities.map((entry, index) => localCapability(entry, `Linux protected refresh child topology capability ${index}`));
  if (new Set(capabilities.map((entry) => entry.name)).size !== capabilities.length
      || new Set(capabilities.map((entry) => entry.id)).size !== capabilities.length) {
    throw new Error('Linux protected refresh child topology capabilities alias');
  }
  const selected = localCapability(value.selectedCapability, 'Linux protected refresh child selected capability');
  if (!capabilities.some((entry) => sameCapability(entry, selected)) || !sameCapability(selected, required)) {
    throw new Error('Linux protected refresh child capability changed');
  }
  if (value.subjects.length < 1 || value.subjects.length > 2) throw new Error('Linux protected refresh child topology subjects are invalid');
  const subjects = value.subjects.map((subject) => {
    exactKeys(subject, new Set(['role', 'policy', 'capability']), 'Linux protected refresh child topology subject');
    const subjectCapability = localCapability(subject.capability, 'Linux protected refresh child topology subject capability');
    if (!['primary', 'compatibility'].includes(subject.role) || subject.policy !== 'group-only'
        || !capabilities.some((entry) => sameCapability(entry, subjectCapability))) {
      throw new Error('Linux protected refresh child topology subject is invalid');
    }
    return Object.freeze({ role: subject.role, capability: subjectCapability });
  });
  const primary = subjects.filter((entry) => entry.role === 'primary');
  const compatibility = subjects.filter((entry) => entry.role === 'compatibility');
  if (primary.length !== 1 || compatibility.length > 1 || !sameCapability(primary[0].capability, required)
      || (value.route === 'combined' && compatibility.length !== 0)) {
    throw new Error('Linux protected refresh child topology subjects are ambiguous');
  }
  const subjectCapabilities = new Set(subjects.map((entry) => `${entry.capability.name}\0${entry.capability.id}`));
  if (subjectCapabilities.size !== capabilities.length
      || capabilities.some((entry) => !subjectCapabilities.has(`${entry.name}\0${entry.id}`))) {
    throw new Error('Linux protected refresh child topology capabilities are incomplete');
  }
  return Object.freeze(capabilities);
}

function exactIdentityEvidence(value, request, capabilities) {
  exactKeys(value, new Set(['protocol', 'platform', 'applicable', 'accounts', 'groups']), 'Linux protected refresh child identity evidence');
  if (value.protocol !== LINUX_LOCAL_IDENTITIES_PROTOCOL || value.platform !== 'linux' || value.applicable !== true
      || !Array.isArray(value.accounts) || value.accounts.length !== 1
      || !Array.isArray(value.groups) || value.groups.length !== capabilities.length) {
    throw new Error('Linux protected refresh child identity evidence is unavailable');
  }
  const account = value.accounts[0];
  exactKeys(account, new Set(['name', 'record', 'groupIds']), 'Linux protected refresh child account evidence');
  exactKeys(account.record, new Set(['name', 'uid', 'gid', 'home', 'shell']), 'Linux protected refresh child account record');
  const expectedPrincipal = request.principal;
  if (account.name !== expectedPrincipal.name || account.record?.name !== expectedPrincipal.name
      || account.record?.uid !== expectedPrincipal.identityId || account.record?.gid !== expectedPrincipal.primaryCapabilityId
      || typeof account.record.home !== 'string' || account.record.home.length < 1 || account.record.home.length > 4096
      || typeof account.record.shell !== 'string' || account.record.shell.length < 1 || account.record.shell.length > 4096
      || /[\0\r\n]/u.test(account.record.home) || /[\0\r\n]/u.test(account.record.shell)
      || !Array.isArray(account.groupIds) || account.groupIds.length > 256
      || account.groupIds.some((entry) => !Number.isSafeInteger(entry) || entry < 0 || entry > MAX_LOCAL_ID)
      || new Set(account.groupIds).size !== account.groupIds.length || !account.groupIds.includes(expectedPrincipal.primaryCapabilityId)
      || capabilities.some((entry) => account.groupIds.includes(entry.id))) {
    throw new Error('Linux protected refresh child identity binding changed');
  }
  for (let index = 0; index < capabilities.length; index += 1) {
    const group = value.groups[index];
    const expected = capabilities[index];
    exactKeys(group, new Set(['name', 'record']), 'Linux protected refresh child group evidence');
    exactKeys(group.record, new Set(['name', 'gid', 'members']), 'Linux protected refresh child group record');
    if (group.name !== expected.name || group.record?.name !== expected.name || group.record?.gid !== expected.id
        || !Array.isArray(group.record.members) || group.record.members.length > 256
        || group.record.members.some((entry) => typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u.test(entry))
        || new Set(group.record.members).size !== group.record.members.length
        || group.record.members.includes(expectedPrincipal.name)) {
      throw new Error('Linux protected refresh child identity binding changed');
    }
  }
}

function exactCandidate(value, expected) {
  exactKeys(value, new Set(['sourceSnapshot', 'node', 'evidence']), 'Linux protected refresh child candidate');
  exactKeys(value.sourceSnapshot, new Set(['digest', 'files']), 'Linux protected refresh child content candidate');
  exactKeys(value.node, new Set(['size', 'digest']), 'Linux protected refresh child executable candidate');
  exactKeys(value.evidence, new Set(['packageDigest', 'nodeDigest']), 'Linux protected refresh child candidate evidence');
  if (!Array.isArray(value.sourceSnapshot.files) || value.sourceSnapshot.files.length > 2_048
      || !Number.isSafeInteger(value.node.size) || value.node.size < 1 || value.node.size > 256 * 1024 * 1024
      || value.sourceSnapshot.digest !== value.evidence.packageDigest || value.node.digest !== value.evidence.nodeDigest
      || value.evidence.packageDigest !== expected.contentDigest || value.evidence.nodeDigest !== expected.executableDigest) {
    throw new Error('Linux protected refresh child candidate changed');
  }
  return value;
}

function unavailable(reason, { changed = false } = {}) {
  return createProtectedRefreshChildResult({ ready: false, changed, generation: null, reason });
}

export async function runLinuxLifecycleAuthorityRefreshChild(rawRequest, providedPorts = {}) {
  exactKeys(providedPorts, new Set([
    'readPlatform',
    'readEffectiveIdentityId',
    'observeOrigin',
    'observeTopology',
    'observeIdentities',
    'observeStateIdentity',
    'measureCandidate',
    'createPlan',
    'bindRuntime',
    'createComposition',
    'refresh',
    'admitClaim',
    'invoke',
    'environment',
    'signal',
  ]), 'Linux protected refresh child ports');
  const ports = Object.freeze({
    readPlatform: providedPorts.readPlatform ?? (() => process.platform),
    readEffectiveIdentityId: providedPorts.readEffectiveIdentityId ?? (() => process.geteuid?.()),
    observeOrigin: providedPorts.observeOrigin,
    observeTopology: providedPorts.observeTopology ?? observeLinuxProviderManagementTopology,
    observeIdentities: providedPorts.observeIdentities ?? observeLinuxLocalIdentities,
    observeStateIdentity: providedPorts.observeStateIdentity ?? observeLinuxLocalStateIdentity,
    measureCandidate: providedPorts.measureCandidate ?? measureProtectedAuthorityRuntimeCandidate,
    createPlan: providedPorts.createPlan ?? createLinuxLifecycleAuthorityPlan,
    bindRuntime: providedPorts.bindRuntime ?? bindLinuxLifecycleAuthorityRuntime,
    createComposition: providedPorts.createComposition ?? createLinuxLifecycleAuthorityRefreshComposition,
    refresh: providedPorts.refresh ?? reconcileLinuxLifecycleAuthorityRefresh,
    admitClaim: providedPorts.admitClaim ?? (async () => true),
    invoke: providedPorts.invoke ?? invokeCommand,
    environment: providedPorts.environment ?? process.env,
    signal: providedPorts.signal ?? null,
  });
  for (const [name, port] of Object.entries(ports)) {
    if (!['environment', 'signal'].includes(name) && typeof port !== 'function') {
      throw new TypeError(`Linux protected refresh child ${name} port is invalid`);
    }
  }

  let request;
  try { request = normalizeProtectedRefreshChildRequest(rawRequest); }
  catch { return unavailable('request-invalid'); }

  let platform;
  let effectiveIdentityId;
  try {
    platform = await ports.readPlatform();
    effectiveIdentityId = await ports.readEffectiveIdentityId();
  } catch {
    return unavailable('invocation-unavailable');
  }
  if (platform !== 'linux') return unavailable('not-applicable');
  if (effectiveIdentityId !== 0) return unavailable('authority-required');

  let origin;
  try { origin = normalizeProtectedRefreshChildOrigin(await ports.observeOrigin()); }
  catch { return unavailable('origin-invalid'); }
  if (origin.principal.name !== request.principal.name
      || origin.principal.identityId !== request.principal.identityId
      || origin.principal.primaryCapabilityId !== request.principal.primaryCapabilityId) {
    return unavailable('origin-mismatch');
  }

  let stateDirectory;
  try { stateDirectory = exactStateIdentity(request.stateIdentity); }
  catch { return unavailable('state-invalid'); }

  let capabilities;
  try {
    capabilities = selectedTopology(await ports.observeTopology({ platform: 'linux', signal: ports.signal }), request.requiredCapability);
  } catch {
    return unavailable('capability-unavailable');
  }

  try {
    const identities = await ports.observeIdentities({
      accountNames: [request.principal.name],
      groupNames: capabilities.map((entry) => entry.name),
      platform: 'linux',
      invoke: ports.invoke,
      environment: ports.environment,
    });
    exactIdentityEvidence(identities, request, capabilities);
  } catch {
    return unavailable('identity-unavailable');
  }

  try {
    stateDirectory = exactStateEvidence(
      await ports.observeStateIdentity({ identity: stateDirectory }),
      stateDirectory,
      request.principal,
    );
  } catch {
    return unavailable('state-untrusted');
  }

  let candidate;
  try {
    candidate = exactCandidate(await ports.measureCandidate({ packageRoot: PACKAGE_ROOT, nodeExecutable: process.execPath }), request.candidate);
  } catch {
    return unavailable('candidate-unavailable');
  }

  let basePlan;
  let candidatePlan;
  try {
    basePlan = ports.createPlan({
      stateDirectory,
      operatorName: request.principal.name,
      managementGroup: request.requiredCapability,
    });
    candidatePlan = ports.bindRuntime(basePlan, {
      packageDigest: candidate.evidence.packageDigest,
      nodeDigest: candidate.evidence.nodeDigest,
    });
  } catch {
    return unavailable('plan-unavailable');
  }

  let composition;
  try {
    composition = await ports.createComposition({
      basePlan,
      candidatePlan,
      candidate,
      packageRoot: PACKAGE_ROOT,
      nodeExecutable: process.execPath,
      admitClaim: ports.admitClaim,
      signal: ports.signal,
      invoke: ports.invoke,
      environment: ports.environment,
    });
    exactKeys(composition, new Set(['protocol', 'generation', 'mechanics']), 'Linux protected refresh child composition');
    if (composition.protocol !== LINUX_LIFECYCLE_AUTHORITY_REFRESH_COMPOSITION_PROTOCOL
        || composition.generation !== candidatePlan.runtime.generation || !composition.mechanics) {
      throw new Error('Linux protected refresh child composition is invalid');
    }
  } catch {
    return unavailable('composition-failed', { changed: null });
  }

  try {
    const result = await ports.refresh({ candidateGeneration: candidatePlan.runtime.generation, mechanics: composition.mechanics });
    exactKeys(result, new Set(['protocol', 'ready', 'changed', 'generation', 'recovered', 'blocker', 'transactionId']), 'Linux protected refresh child result');
    if (result.protocol !== PROTECTED_AUTHORITY_RECONCILIATION_PROTOCOL || result?.ready !== true
        || typeof result.changed !== 'boolean' || result.generation !== candidatePlan.runtime.generation) {
      return unavailable('refresh-not-ready', { changed: typeof result?.changed === 'boolean' ? result.changed : null });
    }
    return createProtectedRefreshChildResult({
      ready: true,
      changed: result.changed,
      generation: candidatePlan.runtime.generation,
      reason: null,
    });
  } catch {
    return unavailable('refresh-failed', { changed: null });
  }
}
