import process from 'node:process';
import {
  assessCapabilitySeparation,
  CAPABILITY_SEPARATION_PROTOCOL,
} from './capability-separation.js';
import {
  CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL,
  observeCurrentPrincipalCapabilities,
} from './current-principal-capabilities.js';
import {
  LINUX_LOCAL_IDENTITIES_PROTOCOL,
  observeLinuxLocalIdentities,
} from './linux-local-identities.js';
import {
  LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL,
  observeLinuxProviderManagementTopology,
} from './linux-provider-management-topology.js';

const PROTOCOL = 'devbridge/linux-provider-authority-preflight-v1';
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const MAX_LOCAL_ID = 0xffff_fffe;
const MAX_CAPABILITIES = 16;
const SEPARATION_REASONS = new Set([
  null,
  'principal-is-privileged',
  'identity-mismatch',
  'primary-capability-mismatch',
  'configured-primary-capability-missing',
  'active-primary-capability-missing',
  'restricted-capability-invalid',
  'configured-capability-present',
  'active-capability-present',
]);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function unavailable(platform, reason, { observable = false, capabilities = [] } = {}) {
  return Object.freeze({
    protocol: PROTOCOL,
    platform,
    applicable: platform === 'linux',
    observable,
    exact: false,
    separation: 'unverified',
    selectedCapability: null,
    capabilities: Object.freeze(capabilities),
    reason,
  });
}

function capability(value, name) {
  exactKeys(value, new Set(['name', 'id']), name);
  if (typeof value.name !== 'string' || !LOCAL_NAME.test(value.name)) throw new Error(`${name} name is invalid`);
  if (!Number.isSafeInteger(value.id) || value.id < 1 || value.id > MAX_LOCAL_ID) throw new Error(`${name} id is invalid`);
  return Object.freeze({ name: value.name, id: value.id });
}

function topologyCapabilities(value) {
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.length > MAX_CAPABILITIES) {
    throw new Error('Linux authority topology capabilities are invalid');
  }
  const selected = Object.freeze(value.capabilities.map((entry, index) => capability(entry, `Linux authority topology capability ${index}`)));
  if (new Set(selected.map((entry) => entry.name)).size !== selected.length
      || new Set(selected.map((entry) => entry.id)).size !== selected.length) {
    throw new Error('Linux authority topology capabilities alias');
  }
  const primary = capability(value.selectedCapability, 'Linux authority selected capability');
  if (!selected.some((entry) => entry.name === primary.name && entry.id === primary.id)) {
    throw new Error('Linux authority selected capability is not in the observed set');
  }
  return Object.freeze({ selected, primary });
}

function identityEvidence(value, principal, capabilities) {
  if (!value || value.protocol !== LINUX_LOCAL_IDENTITIES_PROTOCOL || value.platform !== 'linux' || value.applicable !== true
      || !Array.isArray(value.accounts) || !Array.isArray(value.groups)) {
    throw new Error('Linux authority principal identity evidence is invalid');
  }
  if (value.accounts.length !== 1 || value.accounts[0]?.name !== principal) {
    throw new Error('Linux authority principal identity evidence is incomplete');
  }
  const account = value.accounts[0];
  if (!account.record || account.record.name !== principal
      || !Number.isSafeInteger(account.record.uid) || account.record.uid < 0
      || !Number.isSafeInteger(account.record.gid) || account.record.gid < 0
      || !Array.isArray(account.groupIds)
      || account.groupIds.some((entry) => !Number.isSafeInteger(entry) || entry < 0)
      || new Set(account.groupIds).size !== account.groupIds.length
      || !account.groupIds.includes(account.record.gid)) {
    throw new Error('Linux authority principal identity evidence is invalid');
  }
  if (value.groups.length !== capabilities.length) throw new Error('Linux authority capability identity evidence is incomplete');
  for (const expected of capabilities) {
    const entries = value.groups.filter((entry) => entry?.name === expected.name);
    if (entries.length !== 1 || entries[0].record?.name !== expected.name || entries[0].record?.gid !== expected.id) {
      throw new Error('Linux authority capability identity binding changed');
    }
  }
  return Object.freeze({
    identityId: account.record.uid,
    primaryCapabilityId: account.record.gid,
    configuredCapabilityIds: Object.freeze([...account.groupIds]),
  });
}

function currentEvidence(value) {
  exactKeys(value, new Set(['protocol', 'platform', 'applicable', 'identityIds', 'primaryCapabilityIds', 'capabilityIds']), 'Linux authority current principal evidence');
  if (value.protocol !== CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL || value.platform !== 'linux' || value.applicable !== true) {
    throw new Error('Linux authority current principal evidence is invalid');
  }
  return value;
}

export async function observeLinuxProviderAuthorityPreflight(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['principal', 'platform']), 'Linux authority preflight request');
  exactKeys(providedPorts, new Set(['inspectRoute', 'inspectRecords', 'inspectCurrent', 'assess']), 'Linux authority preflight ports');
  const platform = value.platform ?? process.platform;
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('Linux authority preflight platform is invalid');
  if (platform !== 'linux') return unavailable(platform, 'not-applicable');
  if (typeof value.principal !== 'string' || !LOCAL_NAME.test(value.principal)) throw new TypeError('Linux authority preflight principal is invalid');
  const ports = Object.freeze({
    inspectRoute: providedPorts.inspectRoute ?? observeLinuxProviderManagementTopology,
    inspectRecords: providedPorts.inspectRecords ?? observeLinuxLocalIdentities,
    inspectCurrent: providedPorts.inspectCurrent ?? observeCurrentPrincipalCapabilities,
    assess: providedPorts.assess ?? assessCapabilitySeparation,
  });
  if (Object.values(ports).some((port) => typeof port !== 'function')) throw new TypeError('Linux authority preflight ports are invalid');

  let topology;
  try { topology = await ports.inspectRoute({ platform: 'linux' }); }
  catch { return unavailable('linux', 'topology-observation-unavailable'); }
  if (!topology || topology.protocol !== LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL || topology.platform !== 'linux' || topology.applicable !== true) {
    return unavailable('linux', 'topology-evidence-invalid');
  }
  if (topology.exact !== true || topology.classification !== 'group-only') {
    return unavailable('linux', 'topology-not-group-only', { observable: topology.observable === true });
  }

  let selected;
  try { selected = topologyCapabilities(topology); }
  catch { return unavailable('linux', 'topology-evidence-invalid', { observable: true }); }

  let identities;
  try {
    identities = await ports.inspectRecords({
      accountNames: [value.principal],
      groupNames: selected.selected.map((entry) => entry.name),
      platform: 'linux',
    });
  } catch {
    return unavailable('linux', 'identity-observation-unavailable', { observable: true, capabilities: selected.selected });
  }

  let principal;
  try { principal = identityEvidence(identities, value.principal, selected.selected); }
  catch { return unavailable('linux', 'identity-evidence-invalid', { observable: true, capabilities: selected.selected }); }

  let current;
  try { current = currentEvidence(await ports.inspectCurrent({ platform: 'linux' })); }
  catch { return unavailable('linux', 'current-observation-unavailable', { observable: true, capabilities: selected.selected }); }

  let assessment;
  try {
    assessment = ports.assess({
      principal: Object.freeze({
        ...principal,
        activeIdentityIds: current.identityIds,
        activePrimaryCapabilityIds: current.primaryCapabilityIds,
        activeCapabilityIds: current.capabilityIds,
      }),
      restrictedCapabilityIds: selected.selected.map((entry) => entry.id),
    });
  } catch {
    return unavailable('linux', 'separation-evidence-invalid', { observable: true, capabilities: selected.selected });
  }
  try { exactKeys(assessment, new Set(['protocol', 'exact', 'separated', 'reason']), 'Linux authority separation evidence'); }
  catch { return unavailable('linux', 'separation-evidence-invalid', { observable: true, capabilities: selected.selected }); }
  if (assessment.protocol !== CAPABILITY_SEPARATION_PROTOCOL
      || typeof assessment.exact !== 'boolean' || typeof assessment.separated !== 'boolean'
      || !SEPARATION_REASONS.has(assessment.reason)) {
    return unavailable('linux', 'separation-evidence-invalid', { observable: true, capabilities: selected.selected });
  }
  if (assessment.exact !== true || assessment.separated !== true || assessment.reason !== null) {
    return unavailable('linux', assessment.reason ?? 'separation-unverified', { observable: true, capabilities: selected.selected });
  }
  return Object.freeze({
    protocol: PROTOCOL,
    platform: 'linux',
    applicable: true,
    observable: true,
    exact: true,
    separation: 'verified',
    selectedCapability: selected.primary,
    capabilities: selected.selected,
    reason: null,
  });
}

export { PROTOCOL as LINUX_PROVIDER_AUTHORITY_PREFLIGHT_PROTOCOL };
