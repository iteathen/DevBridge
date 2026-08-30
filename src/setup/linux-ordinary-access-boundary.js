import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PROTOCOL = 'devbridge/ordinary-access-boundary-v1';
const MAX_LOCAL_ID = 0xffff_fffe;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function result({ platform, applicable, ready, reason }) {
  return Object.freeze({ protocol: PROTOCOL, platform, applicable, ready, reason });
}

async function acquireDirectory({ identity, flags }) {
  const handle = await open(identity, flags);
  return Object.freeze({ release: () => handle.close() });
}

async function observeIdentity({ identity }) {
  const before = await lstat(identity);
  const canonical = await realpath(identity);
  const after = await lstat(identity);
  if (canonical !== identity || before.isSymbolicLink() || !before.isDirectory()
      || after.isSymbolicLink() || !after.isDirectory()
      || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
      || before.uid !== after.uid || before.gid !== after.gid) {
    throw new Error('ordinary access identity changed');
  }
  return Object.freeze({ identity: canonical, deviceId: after.dev, objectId: after.ino, mode: after.mode, ownerId: after.uid, groupId: after.gid });
}

function identityEvidence(value) {
  const keys = new Set(['identity', 'deviceId', 'objectId', 'mode', 'ownerId', 'groupId']);
  exactKeys(value, keys, 'ordinary access identity evidence');
  if (Object.keys(value).length !== keys.size || typeof value.identity !== 'string'
      || !['deviceId', 'objectId', 'mode', 'ownerId', 'groupId'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)) {
    throw new Error('ordinary access identity evidence is invalid');
  }
  return value;
}

function sameIdentity(leftValue, rightValue, identity) {
  const left = identityEvidence(leftValue);
  const right = identityEvidence(rightValue);
  return left.identity === identity && right.identity === identity
    && left.deviceId === right.deviceId && left.objectId === right.objectId && left.mode === right.mode
    && left.ownerId === right.ownerId && left.groupId === right.groupId;
}

export async function observeOrdinaryAccessBoundary(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['identity', 'principalId']), 'ordinary access boundary request');
  exactKeys(providedPorts, new Set(['readPlatform', 'readRealIdentityId', 'readEffectiveIdentityId', 'observeIdentity', 'acquire']), 'ordinary access boundary ports');
  const ports = Object.freeze({
    readPlatform: providedPorts.readPlatform ?? (() => process.platform),
    readRealIdentityId: providedPorts.readRealIdentityId ?? process.getuid,
    readEffectiveIdentityId: providedPorts.readEffectiveIdentityId ?? process.geteuid,
    observeIdentity: providedPorts.observeIdentity ?? observeIdentity,
    acquire: providedPorts.acquire ?? acquireDirectory,
  });
  if (Object.values(ports).some((port) => typeof port !== 'function')) throw new TypeError('ordinary access boundary ports are unavailable');

  let platform;
  try { platform = await ports.readPlatform(); }
  catch { return result({ platform: null, applicable: false, ready: false, reason: 'platform-unavailable' }); }
  if (typeof platform !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(platform)) {
    return result({ platform: null, applicable: false, ready: false, reason: 'platform-invalid' });
  }
  if (platform !== 'linux') return result({ platform, applicable: false, ready: false, reason: 'not-applicable' });

  if (typeof value.identity !== 'string' || value.identity.length === 0 || /[\0\r\n]/u.test(value.identity)
      || !path.posix.isAbsolute(value.identity) || path.posix.resolve(value.identity) !== value.identity || value.identity === '/') {
    return result({ platform: 'linux', applicable: true, ready: false, reason: 'identity-invalid' });
  }
  if (!Number.isSafeInteger(value.principalId) || value.principalId < 1 || value.principalId > MAX_LOCAL_ID) {
    return result({ platform: 'linux', applicable: true, ready: false, reason: 'principal-invalid' });
  }

  let realIdentityId;
  let effectiveIdentityId;
  try {
    realIdentityId = await ports.readRealIdentityId();
    effectiveIdentityId = await ports.readEffectiveIdentityId();
  } catch {
    return result({ platform: 'linux', applicable: true, ready: false, reason: 'principal-unavailable' });
  }
  if (realIdentityId !== value.principalId || effectiveIdentityId !== value.principalId) {
    return result({ platform: 'linux', applicable: true, ready: false, reason: 'principal-mismatch' });
  }

  let before;
  try { before = await ports.observeIdentity({ identity: value.identity }); }
  catch { return result({ platform: 'linux', applicable: true, ready: false, reason: 'identity-unavailable' }); }

  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC;
  let acquired;
  try {
    acquired = await ports.acquire({ identity: value.identity, flags });
  } catch (error) {
    let after;
    try { after = await ports.observeIdentity({ identity: value.identity }); }
    catch { return result({ platform: 'linux', applicable: true, ready: false, reason: 'identity-unavailable' }); }
    if (!sameIdentity(before, after, value.identity)) return result({ platform: 'linux', applicable: true, ready: false, reason: 'identity-changed' });
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return result({ platform: 'linux', applicable: true, ready: true, reason: null });
    }
    if (error?.code === 'ENOENT') return result({ platform: 'linux', applicable: true, ready: false, reason: 'identity-absent' });
    if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') return result({ platform: 'linux', applicable: true, ready: false, reason: 'identity-invalid' });
    return result({ platform: 'linux', applicable: true, ready: false, reason: 'access-unavailable' });
  }
  if (!acquired || typeof acquired.release !== 'function' || Object.keys(acquired).some((key) => key !== 'release')) {
    return result({ platform: 'linux', applicable: true, ready: false, reason: 'access-evidence-invalid' });
  }
  try { await acquired.release(); }
  catch { return result({ platform: 'linux', applicable: true, ready: false, reason: 'release-failed' }); }
  let after;
  try { after = await ports.observeIdentity({ identity: value.identity }); }
  catch { return result({ platform: 'linux', applicable: true, ready: false, reason: 'identity-unavailable' }); }
  if (!sameIdentity(before, after, value.identity)) return result({ platform: 'linux', applicable: true, ready: false, reason: 'identity-changed' });
  return result({ platform: 'linux', applicable: true, ready: false, reason: 'direct-access-present' });
}

export { PROTOCOL as ORDINARY_ACCESS_BOUNDARY_PROTOCOL };
