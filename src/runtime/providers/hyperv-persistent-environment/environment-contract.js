import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const TOKEN = /^[a-f0-9]{32}$/u;
const ENVIRONMENT = /^env-[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PROVIDER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const MIN_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_PROCESSORS = 256;
const TRUST_TEMPLATES = Object.freeze({ 'platform-owner': 'MicrosoftWindows' });

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function fileIdentity(info) {
  return { device: String(info.dev), inode: String(info.ino), createdNs: String(info.birthtimeNs ?? 0n) };
}

export class HyperVEnvironmentContract {
  #directory;
  #machineRoot;
  #sourceRoot;
  #identity;
  #normalizeProtection;

  constructor({ directory, machineRoot, sourceRoot, identity, normalizeProtection }) {
    if (typeof machineRoot !== 'string' || machineRoot.length === 0 || machineRoot.includes('\0')) throw new TypeError('environment machine root is invalid');
    if (typeof identity !== 'string' || !TOKEN.test(identity)) throw new TypeError('environment identity is invalid');
    if (typeof normalizeProtection !== 'function') throw new TypeError('environment protection normalizer is required');
    this.#directory = path.resolve(directory);
    this.#machineRoot = path.resolve(machineRoot);
    this.#sourceRoot = path.resolve(sourceRoot);
    this.#identity = identity;
    this.#normalizeProtection = normalizeProtection;
  }

  binding() {
    return createHash('sha256').update(`${this.#identity}:persistent-environment:hyperv:v1`).digest('hex').slice(0, 32);
  }

  descriptor(identity) {
    if (typeof identity !== 'string' || !ENVIRONMENT.test(identity)) throw new TypeError('environment identity is invalid');
    const local = path.join(this.#directory, 'objects', identity);
    const name = `db-env-${createHash('sha256').update(`${this.#identity}:persistent:${identity}`).digest('hex').slice(0, 16)}`;
    return {
      name,
      marker: `devbridge-owned:${this.#identity}:persistent:${identity}:v1`,
      local,
      machineRoot: this.#machineRoot,
      configPath: path.join(this.#machineRoot, name),
      legacyConfigPath: path.join(local, 'machine'),
    };
  }

  request(raw) {
    const input = requireObject(raw, 'environment provision request');
    onlyKeys(input, new Set(['identity', 'source', 'settings']), 'environment provision request');
    return input;
  }

  settings(raw) {
    const value = requireObject(raw, 'environment settings');
    onlyKeys(value, new Set(['memoryBytes', 'processorCount', 'firmware', 'bootProtection']), 'environment settings');
    if (!Number.isSafeInteger(value.memoryBytes) || value.memoryBytes < MIN_MEMORY_BYTES || value.memoryBytes > MAX_MEMORY_BYTES) throw new TypeError('environment settings.memoryBytes is invalid');
    if (!Number.isSafeInteger(value.processorCount) || value.processorCount < 1 || value.processorCount > MAX_PROCESSORS) throw new TypeError('environment settings.processorCount is invalid');
    if (!['efi', 'bios'].includes(value.firmware)) throw new TypeError('environment settings.firmware is invalid');
    const bootProtection = this.#normalizeProtection(value.bootProtection, { optional: true, name: 'environment settings.bootProtection' });
    if (bootProtection && value.firmware !== 'efi') throw new TypeError('environment protected boot requires EFI firmware');
    const settings = { memoryBytes: value.memoryBytes, processorCount: value.processorCount, firmware: value.firmware };
    if (bootProtection) settings.bootProtection = bootProtection;
    return settings;
  }

  bootSettings(settings) {
    const protection = settings.bootProtection ?? null;
    return {
      integrityRequired: protection?.integrity === 'required',
      identityRequired: protection?.identity === 'required',
      trustTemplate: protection ? TRUST_TEMPLATES[protection.trust] : null,
    };
  }

  record(state, identity) {
    const record = state.records[identity];
    if (!record) return null;
    const descriptor = this.descriptor(identity);
    if (record.identity !== identity || !SAFE_ID.test(String(record.sourceIdentity ?? ''))) throw new Error('environment adapter record identity is invalid');
    if (!['vhd', 'vhdx'].includes(record.diskFormat)) throw new Error('environment adapter record format is invalid');
    if (record.providerIdentity != null && !PROVIDER_ID.test(String(record.providerIdentity))) throw new Error('environment adapter provider identity is invalid');
    const expectedDisk = path.join(descriptor.local, `state.${record.diskFormat}`);
    const configPath = path.resolve(record.configPath);
    if (path.resolve(record.diskPath) !== expectedDisk
        || (configPath !== descriptor.configPath && configPath !== descriptor.legacyConfigPath)
        || record.name !== descriptor.name || record.marker !== descriptor.marker) {
      throw new Error('environment adapter record escaped its local contract');
    }
    const parent = path.resolve(record.parentPath);
    const relative = path.relative(this.#sourceRoot, parent);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('environment adapter source record escaped the admitted root');
    return record;
  }

  async source(raw) {
    const value = requireObject(raw, 'environment source');
    onlyKeys(value, new Set(['identity', 'revision', 'digest', 'handle']), 'environment source');
    if (typeof value.identity !== 'string' || !SAFE_ID.test(value.identity)) throw new TypeError('environment source identity is invalid');
    if (typeof value.revision !== 'string' || !SAFE_ID.test(value.revision)) throw new TypeError('environment source revision is invalid');
    const digest = String(value.digest ?? '').toLowerCase();
    if (!DIGEST.test(digest)) throw new TypeError('environment source digest is invalid');
    const handle = requireObject(value.handle, 'environment source handle');
    onlyKeys(handle, new Set(['location', 'format']), 'environment source handle');
    const location = handle.location;
    if (typeof location !== 'string' || location.length === 0 || location.includes('\0')) throw new TypeError('environment source location is invalid');
    const candidate = path.resolve(location);
    const info = await lstat(candidate, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment source must be a real regular file');
    const [root, actual] = await Promise.all([realpath(this.#sourceRoot), realpath(candidate)]);
    const relative = path.relative(root, actual);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('environment source is outside the admitted root');
    const format = String(handle.format ?? '').toLowerCase();
    if (!['vhd', 'vhdx'].includes(format)) throw new Error('environment source media is not supported by this adapter');
    return { identity: value.identity, revision: value.revision, digest, location: actual, format, fileIdentity: fileIdentity(info) };
  }

  providerIdentity(value) {
    const identity = String(value ?? '').toLowerCase();
    if (!PROVIDER_ID.test(identity)) throw new Error('environment management did not return a valid provider identity');
    return identity;
  }

  fileIdentity(info) { return fileIdentity(info); }

  sameFileIdentity(left, right) {
    return left?.device === right?.device && left?.inode === right?.inode && left?.createdNs === right?.createdNs;
  }
}
