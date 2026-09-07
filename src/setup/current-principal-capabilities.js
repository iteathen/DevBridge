import process from 'node:process';

const PROTOCOL = 'devbridge/current-principal-capabilities-v1';
const MAX_CAPABILITIES = 4096;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function numeric(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`);
  return value;
}

function capabilities(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CAPABILITIES) {
    throw new Error('current principal capability set is invalid');
  }
  const selected = value.map((entry) => numeric(entry, 'current principal capability'));
  if (new Set(selected).size !== selected.length) throw new Error('current principal capability set contains a duplicate');
  return Object.freeze(selected.sort((left, right) => left - right));
}

export function observeCurrentPrincipalCapabilities(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['platform']), 'current principal capability request');
  exactKeys(providedPorts, new Set([
    'readRealIdentityId',
    'readEffectiveIdentityId',
    'readRealPrimaryCapabilityId',
    'readEffectivePrimaryCapabilityId',
    'readCapabilityIds',
  ]), 'current principal capability ports');
  const platform = value.platform ?? process.platform;
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('current principal capability platform is invalid');
  if (platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform, applicable: false });
  const ports = Object.freeze({
    readRealIdentityId: providedPorts.readRealIdentityId ?? process.getuid,
    readEffectiveIdentityId: providedPorts.readEffectiveIdentityId ?? process.geteuid,
    readRealPrimaryCapabilityId: providedPorts.readRealPrimaryCapabilityId ?? process.getgid,
    readEffectivePrimaryCapabilityId: providedPorts.readEffectivePrimaryCapabilityId ?? process.getegid,
    readCapabilityIds: providedPorts.readCapabilityIds ?? process.getgroups,
  });
  if (Object.values(ports).some((port) => typeof port !== 'function')) {
    throw new TypeError('current principal capability ports are unavailable');
  }
  try {
    const realIdentityId = numeric(ports.readRealIdentityId(), 'current principal real identity');
    const effectiveIdentityId = numeric(ports.readEffectiveIdentityId(), 'current principal effective identity');
    const realPrimaryCapabilityId = numeric(ports.readRealPrimaryCapabilityId(), 'current principal real primary capability');
    const effectivePrimaryCapabilityId = numeric(ports.readEffectivePrimaryCapabilityId(), 'current principal effective primary capability');
    const capabilityIds = capabilities(ports.readCapabilityIds());
    if (!capabilityIds.includes(effectivePrimaryCapabilityId)) {
      throw new Error('current principal capability set omits the effective primary capability');
    }
    return Object.freeze({
      protocol: PROTOCOL,
      platform: 'linux',
      applicable: true,
      identityIds: Object.freeze([realIdentityId, effectiveIdentityId]),
      primaryCapabilityIds: Object.freeze([realPrimaryCapabilityId, effectivePrimaryCapabilityId]),
      capabilityIds,
    });
  } catch {
    throw new Error('current principal capability observation failed');
  }
}

export { PROTOCOL as CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL };
