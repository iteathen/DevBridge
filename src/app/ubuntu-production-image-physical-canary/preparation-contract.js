import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute local path`);
  return path.resolve(value);
}

function safeString(value, name, maxBytes = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is invalid`);
  return value;
}

async function digestFile(location) {
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(location);
    stream.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return Object.freeze({ bytes, sha256: hash.digest('hex') });
}

async function measureRegularFile(location, expected, name) {
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a real regular file`);
  const measured = await digestFile(location);
  if (expected?.bytes != null && measured.bytes !== expected.bytes) throw new Error(`${name} byte count changed`);
  if (expected?.sha256 != null && measured.sha256 !== expected.sha256) throw new Error(`${name} digest changed`);
  return measured;
}

export function createPreparationContract({ protocol, seedProtocol, accessFamily, sha256Pattern, snapshotPattern, maximumSeedBytes, messages }) {
  if (typeof protocol !== 'string' || protocol.length === 0 || typeof seedProtocol !== 'string' || seedProtocol.length === 0 || typeof accessFamily !== 'string' || accessFamily.length === 0) throw new TypeError('preparation protocol contract is invalid');
  if (!(sha256Pattern instanceof RegExp) || !(snapshotPattern instanceof RegExp) || sha256Pattern.global || sha256Pattern.sticky || snapshotPattern.global || snapshotPattern.sticky) throw new TypeError('preparation pattern contract is invalid');
  if (!Number.isSafeInteger(maximumSeedBytes) || maximumSeedBytes < 1) throw new TypeError('preparation seed limit is invalid');
  if (!messages || typeof messages.identityFile !== 'string' || messages.identityFile.length === 0 || typeof messages.identityChanged !== 'string' || messages.identityChanged.length === 0) throw new TypeError('preparation messages are invalid');

  const normalizeMedia = (raw, name) => {
    const value = onlyKeys(raw, new Set(['location', 'bytes', 'sha256']), name);
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) throw new TypeError(`${name}.bytes is invalid`);
    if (typeof value.sha256 !== 'string' || !sha256Pattern.test(value.sha256)) throw new TypeError(`${name}.sha256 is invalid`);
    return Object.freeze({ location: absolutePath(value.location, `${name}.location`), bytes: value.bytes, sha256: value.sha256 });
  };

  const normalizeNetwork = (raw) => {
    const value = onlyKeys(raw, new Set(['control', 'reference', 'proof', 'addressing']), 'physical preparation network');
    if (!['owned', 'system'].includes(value.control)) throw new TypeError('physical preparation network.control is invalid');
    if (value.addressing !== 'automatic') throw new TypeError('physical preparation network.addressing is invalid');
    return Object.freeze({
      control: value.control,
      reference: safeString(value.reference, 'physical preparation network.reference', 160),
      proof: safeString(value.proof, 'physical preparation network.proof', 2048),
      addressing: value.addressing,
    });
  };

  const normalizeAccess = (raw) => {
    const value = onlyKeys(raw, new Set(['family', 'user', 'identityFile', 'knownHostsFile', 'identitySha256', 'knownHostsSha256']), 'physical preparation access');
    if (value.family !== accessFamily) throw new TypeError('physical preparation access family is invalid');
    if (typeof value.identitySha256 !== 'string' || !sha256Pattern.test(value.identitySha256) || typeof value.knownHostsSha256 !== 'string' || !sha256Pattern.test(value.knownHostsSha256)) throw new TypeError('physical preparation access digest is invalid');
    return Object.freeze({
      family: accessFamily,
      user: safeString(value.user, 'physical preparation access.user', 128),
      identityFile: absolutePath(value.identityFile, 'physical preparation access.identityFile'),
      knownHostsFile: absolutePath(value.knownHostsFile, 'physical preparation access.knownHostsFile'),
      identitySha256: value.identitySha256,
      knownHostsSha256: value.knownHostsSha256,
    });
  };

  const normalize = (raw, expected) => {
    const value = onlyKeys(raw, new Set(['protocol', 'identity', 'payloadGeneration', 'packageGeneration', 'packageSnapshot', 'resources', 'network', 'installer', 'seed', 'access']), 'physical preparation');
    if (value.protocol !== protocol || value.identity !== expected.identity) throw new Error('physical preparation identity changed');
    if (value.payloadGeneration !== expected.payloadGeneration || value.packageGeneration !== expected.packageGeneration) throw new Error('physical preparation generation changed');
    if (typeof value.packageSnapshot !== 'string' || !snapshotPattern.test(value.packageSnapshot) || value.packageSnapshot !== expected.packageSnapshot) throw new Error('physical preparation package snapshot changed');
    const resources = onlyKeys(value.resources, new Set(['memoryBytes', 'processorCount', 'diskBytes']), 'physical preparation resources');
    if (resources.memoryBytes !== expected.resources.memoryBytes || resources.processorCount !== expected.resources.processorCount || resources.diskBytes !== expected.resources.diskBytes) throw new Error('physical preparation resource policy changed');
    return Object.freeze({
      protocol,
      identity: expected.identity,
      payloadGeneration: value.payloadGeneration,
      packageGeneration: value.packageGeneration,
      packageSnapshot: value.packageSnapshot,
      resources: expected.resources,
      network: normalizeNetwork(value.network),
      installer: normalizeMedia(value.installer, 'physical preparation installer'),
      seed: normalizeMedia(value.seed, 'physical preparation seed'),
      access: normalizeAccess(value.access),
    });
  };

  const verify = async (receipt) => {
    await measureRegularFile(receipt.installer.location, receipt.installer, 'physical preparation installer');
    await measureRegularFile(receipt.seed.location, receipt.seed, 'physical preparation seed');
    const identity = await measureRegularFile(receipt.access.identityFile, null, messages.identityFile);
    const knownHosts = await measureRegularFile(receipt.access.knownHostsFile, null, 'physical preparation known-hosts');
    if (identity.sha256 !== receipt.access.identitySha256) throw new Error(messages.identityChanged);
    if (knownHosts.sha256 !== receipt.access.knownHostsSha256) throw new Error('physical preparation known-hosts changed');
    return receipt;
  };

  const readSeed = async (location, identity) => {
    const info = await lstat(location);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumSeedBytes) throw new Error('physical preparation access seed is invalid');
    const value = JSON.parse(await readFile(location, 'utf8'));
    onlyKeys(value, new Set(['protocol', 'target', 'user', 'authorizedKey', 'hostPrivateKey', 'hostPublicKey', 'revision']), 'physical preparation access seed');
    if (value.protocol !== seedProtocol || value.target !== identity || value.revision !== 1) throw new Error('physical preparation access seed identity changed');
    return Object.freeze({
      user: safeString(value.user, 'physical preparation access seed user', 128),
      authorizedKey: safeString(value.authorizedKey, 'physical preparation authorized key', 1024),
      hostPrivateKey: safeString(value.hostPrivateKey, 'physical preparation host private key', 64 * 1024),
      hostPublicKey: safeString(value.hostPublicKey, 'physical preparation host public key', 1024),
    });
  };

  return Object.freeze({ normalize, verify, measureRegularFile, readSeed });
}
