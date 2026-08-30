import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/local-state-identity-v1';

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

export async function observeLinuxLocalStateIdentity(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['identity']), 'local state identity request');
  exactKeys(providedPorts, new Set(['stat', 'resolve']), 'local state identity ports');
  if (typeof value.identity !== 'string' || !path.posix.isAbsolute(value.identity)
      || path.posix.resolve(value.identity) !== value.identity || value.identity === '/') {
    throw new TypeError('local state identity is invalid');
  }
  const stat = providedPorts.stat ?? lstat;
  const resolve = providedPorts.resolve ?? realpath;
  if (typeof stat !== 'function' || typeof resolve !== 'function') throw new TypeError('local state identity ports are invalid');
  const before = await stat(value.identity);
  const canonical = await resolve(value.identity);
  const after = await stat(value.identity);
  if (canonical !== value.identity || before.isSymbolicLink() || !before.isDirectory()
      || after.isSymbolicLink() || !after.isDirectory()
      || !Number.isSafeInteger(before.uid) || before.uid < 1
      || !Number.isSafeInteger(before.mode) || (before.mode & 0o022) !== 0
      || !Number.isSafeInteger(after.mode) || (after.mode & 0o022) !== 0
      || before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid || before.mode !== after.mode) {
    throw new Error('local state identity is untrusted');
  }
  return Object.freeze({ protocol: PROTOCOL, identity: canonical, ownerId: after.uid });
}

export { PROTOCOL as LINUX_LOCAL_STATE_IDENTITY_PROTOCOL };
