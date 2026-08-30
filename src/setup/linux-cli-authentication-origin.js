import process from 'node:process';

const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const LOCAL_ID = /^(0|[1-9][0-9]{0,9})$/u;
const MAX_LOCAL_ID = 0xffff_fffe;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${name} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key) || descriptors[key].enumerable !== true || !Object.hasOwn(descriptors[key], 'value')) {
      throw new TypeError(`${name} contains an unknown field`);
    }
  }
  return value;
}

function numericIdentity(value, name, { allowRoot }) {
  if (typeof value !== 'string' || !LOCAL_ID.test(value)) throw new Error(`${name} is invalid`);
  const selected = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(selected) || selected < (allowRoot ? 0 : 1) || selected > MAX_LOCAL_ID) {
    throw new Error(`${name} is invalid`);
  }
  return selected;
}

export async function observeLinuxCliAuthenticationOrigin(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(), 'authenticated origin request');
  exactKeys(providedPorts, new Set(['readPlatform', 'readEffectiveIdentityId', 'readEnvironment']), 'authenticated origin ports');
  const ports = Object.freeze({
    readPlatform: providedPorts.readPlatform ?? (() => process.platform),
    readEffectiveIdentityId: providedPorts.readEffectiveIdentityId ?? (() => process.geteuid?.()),
    readEnvironment: providedPorts.readEnvironment ?? (() => process.env),
  });
  if (Object.values(ports).some((port) => typeof port !== 'function')) throw new TypeError('authenticated origin ports are invalid');
  if (await ports.readPlatform() !== 'linux' || await ports.readEffectiveIdentityId() !== 0) {
    throw new Error('authenticated origin invocation is invalid');
  }
  const environment = await ports.readEnvironment();
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new Error('authenticated origin evidence is unavailable');
  const evidence = {};
  for (const key of ['SUDO_USER', 'SUDO_UID', 'SUDO_GID']) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('authenticated origin evidence is unavailable');
    evidence[key] = descriptor.value;
  }
  const name = evidence.SUDO_USER;
  if (typeof name !== 'string' || !LOCAL_NAME.test(name) || name === 'root') throw new Error('authenticated origin name is invalid');
  return Object.freeze({
    principal: Object.freeze({
      name,
      identityId: numericIdentity(evidence.SUDO_UID, 'authenticated origin identity', { allowRoot: false }),
      primaryCapabilityId: numericIdentity(evidence.SUDO_GID, 'authenticated origin primary capability', { allowRoot: true }),
    }),
  });
}
