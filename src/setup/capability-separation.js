const PROTOCOL = 'devbridge/capability-separation-v1';
const MAX_CAPABILITIES = 4096;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function numeric(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function numericSet(value, name, { exactLength = null } = {}) {
  if (!Array.isArray(value)
      || value.length === 0
      || value.length > MAX_CAPABILITIES
      || (exactLength != null && value.length !== exactLength)) {
    throw new TypeError(`${name} is invalid`);
  }
  const selected = value.map((entry) => numeric(entry, `${name} entry`));
  if (new Set(selected).size !== selected.length && exactLength == null) throw new TypeError(`${name} contains a duplicate`);
  return Object.freeze(selected);
}

function result(separated, reason) {
  return Object.freeze({ protocol: PROTOCOL, exact: separated, separated, reason });
}

export function assessCapabilitySeparation(value = {}) {
  exactKeys(value, new Set(['principal', 'restrictedCapabilityIds']), 'capability separation request');
  const principal = exactKeys(value.principal, new Set([
    'identityId',
    'primaryCapabilityId',
    'configuredCapabilityIds',
    'activeIdentityIds',
    'activePrimaryCapabilityIds',
    'activeCapabilityIds',
  ]), 'capability separation principal');
  const identityId = numeric(principal.identityId, 'capability separation identity');
  const primaryCapabilityId = numeric(principal.primaryCapabilityId, 'capability separation primary capability');
  const configuredCapabilityIds = numericSet(principal.configuredCapabilityIds, 'configured capability set');
  const activeIdentityIds = numericSet(principal.activeIdentityIds, 'active identity set', { exactLength: 2 });
  const activePrimaryCapabilityIds = numericSet(principal.activePrimaryCapabilityIds, 'active primary capability set', { exactLength: 2 });
  const activeCapabilityIds = numericSet(principal.activeCapabilityIds, 'active capability set');
  const restrictedCapabilityIds = numericSet(value.restrictedCapabilityIds, 'restricted capability set');

  if (identityId === 0 || primaryCapabilityId === 0) return result(false, 'principal-is-privileged');
  if (activeIdentityIds.some((entry) => entry !== identityId)) return result(false, 'identity-mismatch');
  if (activePrimaryCapabilityIds.some((entry) => entry !== primaryCapabilityId)) return result(false, 'primary-capability-mismatch');
  if (!configuredCapabilityIds.includes(primaryCapabilityId)) return result(false, 'configured-primary-capability-missing');
  if (!activeCapabilityIds.includes(activePrimaryCapabilityIds[1])) return result(false, 'active-primary-capability-missing');
  if (restrictedCapabilityIds.includes(0) || new Set(restrictedCapabilityIds).size !== restrictedCapabilityIds.length) {
    return result(false, 'restricted-capability-invalid');
  }
  if (configuredCapabilityIds.some((entry) => restrictedCapabilityIds.includes(entry))) {
    return result(false, 'configured-capability-present');
  }
  if (activePrimaryCapabilityIds.some((entry) => restrictedCapabilityIds.includes(entry))
      || activeCapabilityIds.some((entry) => restrictedCapabilityIds.includes(entry))) {
    return result(false, 'active-capability-present');
  }
  return result(true, null);
}

export { PROTOCOL as CAPABILITY_SEPARATION_PROTOCOL };
