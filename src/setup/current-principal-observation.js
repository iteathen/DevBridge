const PROTOCOL = 'devbridge/current-principal-observation-v1';
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const MAX_LOCAL_ID = 0xffff_fffe;

function exactObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')
      || Object.keys(descriptors).length !== keys.size) {
    throw new TypeError(`${name} is invalid`);
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${name} contains an unknown field`);
    }
  }
  return value;
}

function localId(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LOCAL_ID) throw new TypeError(`${name} is invalid`);
  return value;
}

function principal(value) {
  exactObject(value, new Set(['name', 'identityId', 'primaryCapabilityId']), 'current principal record');
  if (typeof value.name !== 'string' || !LOCAL_NAME.test(value.name)) throw new TypeError('current principal name is invalid');
  return Object.freeze({
    name: value.name,
    identityId: localId(value.identityId, 'current principal identity'),
    primaryCapabilityId: localId(value.primaryCapabilityId, 'current principal primary capability'),
  });
}

function result({ ready, value = null, reason = null }) {
  return Object.freeze({ protocol: PROTOCOL, ready, principal: value, reason });
}

function unavailable(reason) {
  return result({ ready: false, reason });
}

export async function observeCurrentPrincipal(value = {}, providedPorts = {}) {
  exactObject(value, new Set(), 'current principal observation request');
  exactObject(providedPorts, new Set([
    'readRecord',
    'readRealIdentityId',
    'readEffectiveIdentityId',
    'readRealPrimaryCapabilityId',
    'readEffectivePrimaryCapabilityId',
  ]), 'current principal observation ports');
  if (Object.values(providedPorts).some((port) => typeof port !== 'function')) {
    throw new TypeError('current principal observation ports are invalid');
  }

  let observed;
  let realIdentityId;
  let effectiveIdentityId;
  let realPrimaryCapabilityId;
  let effectivePrimaryCapabilityId;
  try {
    [observed, realIdentityId, effectiveIdentityId, realPrimaryCapabilityId, effectivePrimaryCapabilityId] = await Promise.all([
      providedPorts.readRecord(),
      providedPorts.readRealIdentityId(),
      providedPorts.readEffectiveIdentityId(),
      providedPorts.readRealPrimaryCapabilityId(),
      providedPorts.readEffectivePrimaryCapabilityId(),
    ]);
  } catch {
    return unavailable('observation-unavailable');
  }

  let selected;
  try {
    selected = principal(observed);
    localId(realIdentityId, 'current principal real identity');
    localId(effectiveIdentityId, 'current principal effective identity');
    localId(realPrimaryCapabilityId, 'current principal real primary capability');
    localId(effectivePrimaryCapabilityId, 'current principal effective primary capability');
  } catch {
    return unavailable('evidence-invalid');
  }
  if (realIdentityId !== selected.identityId || effectiveIdentityId !== selected.identityId
      || realPrimaryCapabilityId !== selected.primaryCapabilityId
      || effectivePrimaryCapabilityId !== selected.primaryCapabilityId) {
    return unavailable('identity-mismatch');
  }
  return result({ ready: true, value: selected });
}

export { PROTOCOL as CURRENT_PRINCIPAL_OBSERVATION_PROTOCOL };
