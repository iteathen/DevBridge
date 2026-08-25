import { createHash } from 'node:crypto';
import path from 'node:path';
import { invokeCommand } from '../runtime/command-invocation.js';
import { EnvironmentBridge } from '../runtime/environment-bridge.js';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';
import { HyperVEnvironmentBridge } from '../runtime/providers/hyperv-environment-bridge.js';
import { LibvirtEnvironmentBridge } from '../runtime/providers/libvirt-environment-bridge.js';

const FOUNDATION_IDENTITY = /^[a-f0-9]{32}$/u;

function environmentReference(identity, target) {
  return `db-env-${createHash('sha256').update(`${identity}:persistent:${target}`).digest('hex').slice(0, 16)}`;
}

function ownershipProof(identity, target) {
  return `devbridge-owned:${identity}:persistent:${target}:v1`;
}

function environmentIdentity(identity, target) {
  const hex = createHash('sha256').update(`${identity}:persistent:${target}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function currentLocation(identity, platform) {
  if (platform === 'win32') {
    return async (target) => ({ reference: environmentReference(identity, target), proof: ownershipProof(identity, target) });
  }
  if (platform === 'linux') {
    return async (target) => ({ reference: environmentReference(identity, target), identity: environmentIdentity(identity, target), proof: ownershipProof(identity, target) });
  }
  return null;
}

function foundationIdentity(value) {
  if (typeof value !== 'string' || !FOUNDATION_IDENTITY.test(value)) throw new TypeError('bridge foundationIdentity is invalid');
  return value;
}

export async function createEnvironmentBridge({
  stateDirectory,
  foundationIdentity: injectedFoundationIdentity = null,
  platform = process.platform,
  invoke = invokeCommand,
  access,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('stateDirectory is required');
  if (typeof access !== 'function') throw new TypeError('bridge access must be a function');
  const identity = injectedFoundationIdentity == null
    ? await loadOrCreateLocalIdentity({ directory: path.join(path.resolve(stateDirectory), 'environment-foundation') })
    : foundationIdentity(injectedFoundationIdentity);
  const locate = currentLocation(identity, platform);
  let attachment;
  if (platform === 'win32') attachment = new HyperVEnvironmentBridge({ invoke, access, locate });
  else if (platform === 'linux') attachment = new LibvirtEnvironmentBridge({ invoke, access, locate });
  else throw new Error('no environment bridge attachment is available for this host platform');
  return new EnvironmentBridge({ exchange: attachment.exchange.bind(attachment) });
}
