const REQUEST_PROTOCOL = 'devbridge/protected-refresh-child-request-v1';
const RESULT_PROTOCOL = 'devbridge/protected-refresh-child-result-v1';
const DIGEST = /^[0-9a-f]{64}$/u;
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const REASON = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_LOCAL_ID = 0xffff_fffe;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function localName(value, name) {
  if (typeof value !== 'string' || !LOCAL_NAME.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function localId(value, name, { allowRoot = true } = {}) {
  const minimum = allowRoot ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_LOCAL_ID) throw new TypeError(`${name} is invalid`);
  return value;
}

function principal(value, name) {
  exactKeys(value, new Set(['name', 'identityId', 'primaryCapabilityId']), name);
  return Object.freeze({
    name: localName(value.name, `${name} name`),
    identityId: localId(value.identityId, `${name} identityId`, { allowRoot: false }),
    primaryCapabilityId: localId(value.primaryCapabilityId, `${name} primaryCapabilityId`),
  });
}

function capability(value, name) {
  exactKeys(value, new Set(['name', 'id']), name);
  return Object.freeze({
    name: localName(value.name, `${name} name`),
    id: localId(value.id, `${name} id`, { allowRoot: false }),
  });
}

function candidate(value, name) {
  exactKeys(value, new Set(['contentDigest', 'executableDigest']), name);
  if (typeof value.contentDigest !== 'string' || !DIGEST.test(value.contentDigest)
      || typeof value.executableDigest !== 'string' || !DIGEST.test(value.executableDigest)) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze({ contentDigest: value.contentDigest, executableDigest: value.executableDigest });
}

export function normalizeProtectedRefreshChildRequest(value) {
  exactKeys(value, new Set(['protocol', 'stateIdentity', 'principal', 'requiredCapability', 'candidate']), 'protected refresh child request');
  if (value.protocol !== REQUEST_PROTOCOL) throw new TypeError('protected refresh child request protocol is invalid');
  if (typeof value.stateIdentity !== 'string' || value.stateIdentity.length < 2 || value.stateIdentity.length > 4096
      || /[\0\r\n]/u.test(value.stateIdentity)) {
    throw new TypeError('protected refresh child state identity is invalid');
  }
  return Object.freeze({
    protocol: REQUEST_PROTOCOL,
    stateIdentity: value.stateIdentity,
    principal: principal(value.principal, 'protected refresh child principal'),
    requiredCapability: capability(value.requiredCapability, 'protected refresh child required capability'),
    candidate: candidate(value.candidate, 'protected refresh child candidate'),
  });
}

export function normalizeProtectedRefreshChildOrigin(value) {
  exactKeys(value, new Set(['principal']), 'protected refresh child origin');
  return Object.freeze({ principal: principal(value.principal, 'protected refresh child origin principal') });
}

export function createProtectedRefreshChildResult({ ready, changed, generation, reason } = {}) {
  if (typeof ready !== 'boolean') throw new TypeError('protected refresh child result readiness is invalid');
  if (changed !== null && typeof changed !== 'boolean') throw new TypeError('protected refresh child result change evidence is invalid');
  if (ready) {
    if (changed == null || typeof generation !== 'string' || !DIGEST.test(generation) || reason !== null) {
      throw new TypeError('protected refresh child ready result is invalid');
    }
  } else if (generation !== null || typeof reason !== 'string' || !REASON.test(reason)) {
    throw new TypeError('protected refresh child unavailable result is invalid');
  }
  return Object.freeze({ protocol: RESULT_PROTOCOL, ready, changed, generation, reason });
}

export {
  REQUEST_PROTOCOL as PROTECTED_REFRESH_CHILD_REQUEST_PROTOCOL,
  RESULT_PROTOCOL as PROTECTED_REFRESH_CHILD_RESULT_PROTOCOL,
};
