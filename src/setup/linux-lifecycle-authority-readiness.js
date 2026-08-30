import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import {
  CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL,
  observeCurrentPrincipalCapabilities,
} from './current-principal-capabilities.js';
import {
  bindLinuxLifecycleAuthorityRuntime,
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from './linux-lifecycle-authority.js';
import {
  inspectLinuxLifecycleAuthorityState,
  LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL,
} from './linux-lifecycle-authority-inspection.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_PLAN_SELECTION_PROTOCOL,
  selectLinuxLifecycleAuthorityPlan,
} from './linux-lifecycle-authority-plan-selection.js';
import {
  probeLinuxLifecycleAuthority,
} from './linux-lifecycle-authority-refresh-composition.js';
import {
  LINUX_LOCAL_IDENTITIES_PROTOCOL,
  observeLinuxLocalIdentities,
} from './linux-local-identities.js';
import {
  LINUX_LOCAL_STATE_IDENTITY_PROTOCOL,
  observeLinuxLocalStateIdentity,
} from './linux-local-state-identity.js';
import {
  observeOrdinaryAccessBoundary,
  ORDINARY_ACCESS_BOUNDARY_PROTOCOL,
} from './linux-ordinary-access-boundary.js';
import {
  measureProtectedAuthorityRuntimeCandidate,
} from './protected-authority-runtime-candidate.js';
import {
  createProtectedReadinessObservation,
} from './protected-readiness-reconciliation.js';
import {
  normalizeProtectedRefreshChildRequest,
  PROTECTED_REFRESH_CHILD_REQUEST_PROTOCOL,
} from './protected-refresh-child-contract.js';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_LOCAL_ID = 0xffff_fffe;
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
const FILESYSTEM_KEYS = Object.freeze([
  'unit',
  'endpointDefinition',
  'protectedRoot',
  'authorityState',
  'ownershipManifest',
  'generationsDirectory',
  'generationDirectory',
  'binDirectory',
  'packageDirectory',
  'generationManifest',
  'nodeExecutable',
  'packageManifest',
  'serviceEntry',
  'endpointsParent',
  'runRoot',
  'governanceDirectory',
  'governanceLock',
  'readDirectory',
  'mutationDirectory',
  'readEndpoint',
  'mutationEndpoint',
  'configurationRoot',
  'configurationEndpointDirectory',
  'configurationHandoffDirectory',
  'configurationEndpoint',
  'activityRoot',
  'activityEndpointDirectory',
  'activityHandoffDirectory',
  'activityEndpoint',
]);
const SERVICE_KEYS = new Set([
  'protocol', 'platform', 'applicable', 'observable', 'exists', 'reason', 'loadState', 'activeState', 'subState',
  'mainPid', 'fragmentPath', 'user', 'group', 'supplementaryGroups', 'type', 'unitFileState', 'needsReload',
  'dropIns', 'definitionCurrent', 'unitExact', 'identity', 'groups', 'fragment', 'startBoundary', 'enabled',
]);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  if (Object.keys(value).length !== allowed.size) throw new TypeError(`${name} is incomplete`);
  return value;
}

function exactStateIdentity(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value || value === '/') {
    throw new TypeError('Linux lifecycle authority readiness state identity is invalid');
  }
  return value;
}

function exactPrincipal(value) {
  if (typeof value !== 'string' || !LOCAL_NAME.test(value)) throw new TypeError('Linux lifecycle authority readiness principal is invalid');
  return value;
}

function exactPlanSelection(value, request) {
  exactKeys(value, new Set(['protocol', 'platform', 'applicable', 'ready', 'reason', 'plan']), 'Linux lifecycle authority readiness selection');
  if (value.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_SELECTION_PROTOCOL || value.platform !== 'linux'
      || value.applicable !== true || value.ready !== true || value.reason !== null) {
    throw new Error('Linux lifecycle authority readiness plan is unavailable');
  }
  const plan = exactKeys(value.plan, PLAN_KEYS, 'Linux lifecycle authority readiness plan');
  if (plan.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL || plan.stateDirectory !== request.stateIdentity
      || plan.service?.operator !== request.principal || plan.runtimeEvidence !== null || plan.runtime?.generation != null
      || typeof plan.service?.managementGroup !== 'string' || !LOCAL_NAME.test(plan.service.managementGroup)
      || !Number.isSafeInteger(plan.service?.managementGroupId) || plan.service.managementGroupId < 1
      || plan.service.managementGroupId > MAX_LOCAL_ID) {
    throw new Error('Linux lifecycle authority readiness plan is invalid');
  }
  return plan;
}

function exactCandidate(value) {
  exactKeys(value, new Set(['sourceSnapshot', 'node', 'evidence']), 'Linux lifecycle authority readiness candidate');
  exactKeys(value.sourceSnapshot, new Set(['digest', 'files']), 'Linux lifecycle authority readiness content candidate');
  exactKeys(value.node, new Set(['size', 'digest']), 'Linux lifecycle authority readiness executable candidate');
  exactKeys(value.evidence, new Set(['packageDigest', 'nodeDigest']), 'Linux lifecycle authority readiness candidate evidence');
  if (!Array.isArray(value.sourceSnapshot.files) || value.sourceSnapshot.files.length > 2_048
      || !Number.isSafeInteger(value.node.size) || value.node.size < 1 || value.node.size > 256 * 1024 * 1024
      || !DIGEST.test(value.sourceSnapshot.digest) || !DIGEST.test(value.node.digest)
      || value.sourceSnapshot.digest !== value.evidence.packageDigest || value.node.digest !== value.evidence.nodeDigest) {
    throw new Error('Linux lifecycle authority readiness candidate is invalid');
  }
  return value;
}

function exactBoundPlan(value, base, candidate) {
  const plan = exactKeys(value, PLAN_KEYS, 'Linux lifecycle authority readiness bound plan');
  if (plan.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL || plan.authorityIdentity !== base.authorityIdentity
      || plan.stateDirectory !== base.stateDirectory || plan.protectedRoot !== base.protectedRoot
      || plan.service?.managementGroup !== base.service.managementGroup
      || plan.service?.managementGroupId !== base.service.managementGroupId
      || plan.runtimeEvidence?.packageDigest !== candidate.evidence.packageDigest
      || plan.runtimeEvidence?.nodeDigest !== candidate.evidence.nodeDigest
      || typeof plan.runtime?.generation !== 'string' || !DIGEST.test(plan.runtime.generation)
      || typeof plan.service?.unit !== 'string') {
    throw new Error('Linux lifecycle authority readiness bound plan is invalid');
  }
  return plan;
}

function currentPrincipal(value, identity, restrictedCapabilityId) {
  exactKeys(value, new Set(['protocol', 'platform', 'applicable', 'identityIds', 'primaryCapabilityIds', 'capabilityIds']), 'Linux lifecycle authority readiness current principal');
  if (value.protocol !== CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL || value.platform !== 'linux' || value.applicable !== true
      || !Array.isArray(value.identityIds) || value.identityIds.length !== 2 || value.identityIds.some((entry) => entry !== identity.identityId)
      || !Array.isArray(value.primaryCapabilityIds) || value.primaryCapabilityIds.length !== 2
      || value.primaryCapabilityIds.some((entry) => entry !== identity.primaryCapabilityId)
      || !Array.isArray(value.capabilityIds) || !value.capabilityIds.includes(identity.primaryCapabilityId)
      || value.capabilityIds.includes(restrictedCapabilityId)) {
    throw new Error('Linux lifecycle authority readiness current principal changed');
  }
}

function exactIdentity(value, plan, principal) {
  exactKeys(value, new Set(['protocol', 'platform', 'applicable', 'accounts', 'groups']), 'Linux lifecycle authority readiness identities');
  if (value.protocol !== LINUX_LOCAL_IDENTITIES_PROTOCOL || value.platform !== 'linux' || value.applicable !== true
      || !Array.isArray(value.accounts) || value.accounts.length !== 2 || !Array.isArray(value.groups) || value.groups.length !== 4) {
    throw new Error('Linux lifecycle authority readiness identity evidence is unavailable');
  }
  const operator = value.accounts.find((entry) => entry?.name === principal);
  exactKeys(operator, new Set(['name', 'record', 'groupIds']), 'Linux lifecycle authority readiness operator');
  exactKeys(operator.record, new Set(['name', 'uid', 'gid', 'home', 'shell']), 'Linux lifecycle authority readiness operator record');
  if (operator.record.name !== principal || !Number.isSafeInteger(operator.record.uid) || operator.record.uid < 1
      || operator.record.uid > MAX_LOCAL_ID || !Number.isSafeInteger(operator.record.gid) || operator.record.gid < 1
      || operator.record.gid > MAX_LOCAL_ID || !Array.isArray(operator.groupIds)
      || new Set(operator.groupIds).size !== operator.groupIds.length || !operator.groupIds.includes(operator.record.gid)
      || operator.groupIds.includes(plan.service.managementGroupId)) {
    throw new Error('Linux lifecycle authority readiness operator evidence is invalid');
  }
  const management = value.groups.find((entry) => entry?.name === plan.service.managementGroup);
  exactKeys(management, new Set(['name', 'record']), 'Linux lifecycle authority readiness capability');
  exactKeys(management.record, new Set(['name', 'gid', 'members']), 'Linux lifecycle authority readiness capability record');
  if (management.record.name !== plan.service.managementGroup || management.record.gid !== plan.service.managementGroupId
      || !Array.isArray(management.record.members) || management.record.members.includes(principal)) {
    throw new Error('Linux lifecycle authority readiness capability binding changed');
  }
  return Object.freeze({
    name: principal,
    identityId: operator.record.uid,
    primaryCapabilityId: operator.record.gid,
  });
}

function exactState(value, plan, principal) {
  exactKeys(value, new Set(['protocol', 'identity', 'ownerId']), 'Linux lifecycle authority readiness state identity');
  if (value.protocol !== LINUX_LOCAL_STATE_IDENTITY_PROTOCOL || value.identity !== plan.stateDirectory
      || value.ownerId !== principal.identityId) {
    throw new Error('Linux lifecycle authority readiness state identity changed');
  }
}

function completeInspection(value, plan, principal) {
  exactKeys(value, new Set(['protocol', 'platform', 'applicable', 'authorityIdentity', 'identities', 'ownership', 'generation', 'topology', 'service', 'process', 'filesystem', 'runtime']), 'Linux lifecycle authority readiness inspection');
  if (value.protocol !== LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL || value.platform !== 'linux'
      || value.applicable !== true || value.authorityIdentity !== plan.authorityIdentity) return false;
  exactKeys(value.identities, new Set(['service', 'operator', 'serviceUid', 'operatorUid', 'readGid', 'coordinationGid', 'managementGid', 'rootGid', 'serviceGroupIds']), 'Linux lifecycle authority readiness identity projection');
  exactKeys(value.ownership, new Set(['exists', 'exact', 'record']), 'Linux lifecycle authority readiness ownership projection');
  exactKeys(value.generation, new Set(['exists', 'exact', 'record']), 'Linux lifecycle authority readiness generation projection');
  exactKeys(value.topology, new Set(['definitionExact']), 'Linux lifecycle authority readiness topology projection');
  exactKeys(value.service, SERVICE_KEYS, 'Linux lifecycle authority readiness service projection');
  exactKeys(value.process, new Set(['observable', 'identity', 'groups', 'executable', 'uids', 'gids', 'groupIds']), 'Linux lifecycle authority readiness process projection');
  exactKeys(value.filesystem, new Set(FILESYSTEM_KEYS), 'Linux lifecycle authority readiness filesystem projection');
  for (const name of FILESYSTEM_KEYS) {
    const entry = exactKeys(value.filesystem[name], new Set(['exists', 'kind', 'owner', 'group', 'mode', 'observedMode']), `Linux lifecycle authority readiness filesystem ${name}`);
    if (entry.exists !== true || entry.kind !== true || entry.owner !== true || entry.group !== true || entry.mode !== true) return false;
  }
  exactKeys(value.runtime, new Set(['ready', 'exact', 'generation']), 'Linux lifecycle authority readiness runtime projection');
  return value.identities.service === true && value.identities.operator === true
    && value.identities.operatorUid === principal.identityId && value.identities.managementGid === plan.service.managementGroupId
    && value.identities.rootGid === 0 && value.ownership.exists === true && value.ownership.exact === true
    && value.ownership.record != null && value.generation.exists === true && value.generation.exact === true
    && value.generation.record != null && value.topology.definitionExact === true
    && value.service.observable === true && value.service.exists === true && value.service.reason === null
    && value.service.loadState === 'loaded' && value.service.activeState === 'active' && value.service.mainPid > 0
    && value.service.needsReload === false && value.service.dropIns === false && value.service.definitionCurrent === true
    && value.service.unitExact === true && value.service.identity === true && value.service.groups === true
    && value.service.fragment === true && value.service.startBoundary === true && value.service.enabled === true
    && value.process.observable === true && value.process.identity === true && value.process.groups === true
    && value.process.executable === true && value.runtime.ready === true && value.runtime.exact === true
    && value.runtime.generation === plan.runtime.generation;
}

function refreshSubject(plan, principal, candidate) {
  return normalizeProtectedRefreshChildRequest({
    protocol: PROTECTED_REFRESH_CHILD_REQUEST_PROTOCOL,
    stateIdentity: plan.stateDirectory,
    principal,
    requiredCapability: Object.freeze({ name: plan.service.managementGroup, id: plan.service.managementGroupId }),
    candidate: Object.freeze({
      contentDigest: candidate.evidence.packageDigest,
      executableDigest: candidate.evidence.nodeDigest,
    }),
  });
}

function unavailable(reason, { subject = null, generation = null } = {}) {
  return createProtectedReadinessObservation({ ready: false, subject, generation, reason });
}

export async function observeLinuxLifecycleAuthorityReadiness(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['stateIdentity', 'principal']), 'Linux lifecycle authority readiness request');
  if (!providedPorts || typeof providedPorts !== 'object' || Array.isArray(providedPorts)) throw new TypeError('Linux lifecycle authority readiness ports are invalid');
  const allowedPorts = new Set(['select', 'observeIdentities', 'observeCurrent', 'observeState', 'measure', 'bind', 'inspect', 'observeBoundary', 'probe']);
  for (const key of Object.keys(providedPorts)) if (!allowedPorts.has(key)) throw new TypeError('Linux lifecycle authority readiness ports contain an unknown field');
  const request = Object.freeze({ stateIdentity: exactStateIdentity(value.stateIdentity), principal: exactPrincipal(value.principal) });
  const ports = Object.freeze({
    select: providedPorts.select ?? selectLinuxLifecycleAuthorityPlan,
    observeIdentities: providedPorts.observeIdentities ?? observeLinuxLocalIdentities,
    observeCurrent: providedPorts.observeCurrent ?? observeCurrentPrincipalCapabilities,
    observeState: providedPorts.observeState ?? observeLinuxLocalStateIdentity,
    measure: providedPorts.measure ?? measureProtectedAuthorityRuntimeCandidate,
    bind: providedPorts.bind ?? bindLinuxLifecycleAuthorityRuntime,
    inspect: providedPorts.inspect ?? inspectLinuxLifecycleAuthorityState,
    observeBoundary: providedPorts.observeBoundary ?? observeOrdinaryAccessBoundary,
    probe: providedPorts.probe ?? probeLinuxLifecycleAuthority,
  });
  if (Object.values(ports).some((port) => typeof port !== 'function')) throw new TypeError('Linux lifecycle authority readiness ports are invalid');

  let basePlan;
  try { basePlan = exactPlanSelection(await ports.select({ stateDirectory: request.stateIdentity, principal: request.principal }), request); }
  catch { return unavailable('plan-unavailable'); }

  let candidate;
  let plan;
  try {
    candidate = exactCandidate(await ports.measure({ packageRoot: PACKAGE_ROOT, nodeExecutable: process.execPath }));
    plan = exactBoundPlan(ports.bind(basePlan, candidate.evidence), basePlan, candidate);
  } catch {
    return unavailable('candidate-unavailable');
  }

  let identities;
  let principal;
  try {
    identities = await ports.observeIdentities({
      accountNames: [request.principal, plan.service.user],
      groupNames: ['root', plan.service.readGroup, plan.service.coordinationGroup, plan.service.managementGroup],
      platform: 'linux',
    });
    principal = exactIdentity(identities, plan, request.principal);
    currentPrincipal(await ports.observeCurrent({ platform: 'linux' }), principal, plan.service.managementGroupId);
    exactState(await ports.observeState({ identity: plan.stateDirectory }), plan, principal);
  } catch {
    return unavailable('identity-unavailable', { generation: plan.runtime.generation });
  }

  const subject = refreshSubject(plan, principal, candidate);
  let inspection;
  try { inspection = await ports.inspect({ plan, identities, platform: 'linux' }); }
  catch { return unavailable('refresh-required', { subject, generation: plan.runtime.generation }); }
  try {
    if (!completeInspection(inspection, plan, principal)) {
      return unavailable('refresh-required', { subject, generation: plan.runtime.generation });
    }
  } catch {
    return unavailable('refresh-required', { subject, generation: plan.runtime.generation });
  }

  let boundary;
  try { boundary = await ports.observeBoundary({ identity: plan.authorityDirectory, principalId: principal.identityId }); }
  catch { return unavailable('access-boundary-unverified', { generation: plan.runtime.generation }); }
  try {
    exactKeys(boundary, new Set(['protocol', 'platform', 'applicable', 'ready', 'reason']), 'Linux lifecycle authority readiness access boundary');
    if (boundary.protocol !== ORDINARY_ACCESS_BOUNDARY_PROTOCOL || boundary.platform !== 'linux'
        || boundary.applicable !== true || boundary.ready !== true || boundary.reason !== null) {
      return unavailable('access-boundary-unverified', { generation: plan.runtime.generation });
    }
  } catch {
    return unavailable('access-boundary-unverified', { generation: plan.runtime.generation });
  }

  try {
    const health = await ports.probe({ plan });
    if (!health || health.protocol !== 'devbridge/environment-operator-v1') throw new Error('health evidence is invalid');
  } catch {
    return unavailable('refresh-required', { subject, generation: plan.runtime.generation });
  }
  return createProtectedReadinessObservation({ ready: true, subject: null, generation: plan.runtime.generation, reason: null });
}
