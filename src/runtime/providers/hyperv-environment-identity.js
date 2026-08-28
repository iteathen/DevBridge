import { createHash } from 'node:crypto';

const IDENTITY = /^[a-f0-9]{32}$/u;

function exactIdentity(value) {
  if (typeof value !== 'string' || !IDENTITY.test(value)) throw new TypeError('environment provider identity is invalid');
  return value;
}

function ownedName(identity, kind, value = '') {
  return `db-${kind}-${createHash('sha256').update(`${identity}:${kind}:${value}`).digest('hex').slice(0, 16)}`;
}

function ownership(identity, kind, value = '') {
  return `devbridge-owned:${identity}:${kind}:${value || 'default'}:v1`;
}

export function environmentNetworkDescriptor(identity) {
  const selected = exactIdentity(identity);
  const digest = createHash('sha256').update(`${selected}:network`).digest();
  const third = 64 + (digest[0] % 128);
  return Object.freeze({
    name: ownedName(selected, 'network'),
    marker: ownership(selected, 'network'),
    prefix: `192.168.${third}.0/24`,
    gateway: `192.168.${third}.1`,
  });
}

export function environmentInstanceDescriptor(identity, value) {
  const selected = exactIdentity(identity);
  if (typeof value !== 'string' || !/^[a-f0-9]{32,64}$/u.test(value)) throw new TypeError('instance identity must be an opaque local token');
  return Object.freeze({ name: ownedName(selected, 'instance', value), marker: ownership(selected, 'instance', value) });
}
