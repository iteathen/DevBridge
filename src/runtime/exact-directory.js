import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, rmdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { sameFilesystemIdentity } from './local-filesystem-identity.js';

export const EXACT_DIRECTORY_PROTOCOL = 'devbridge/exact-directory-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function selectedPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function identity(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function observedIdentity(info) {
  return Object.freeze({
    device: info.dev.toString(),
    inode: info.ino.toString(),
    createdNs: info.birthtimeNs.toString(),
  });
}

function sameIdentity(expected, info) {
  const current = observedIdentity(info);
  return Object.keys(current).every((key) => expected?.[key] === current[key]);
}

function normalizeRequest(raw, selectedPathModule) {
  const value = onlyKeys(raw, new Set(['identity', 'location']), 'exact directory request');
  const location = value.location;
  if (typeof location !== 'string' || location.length === 0 || location.includes('\0')
      || !selectedPathModule.isAbsolute(location)) throw new TypeError('exact directory location is invalid');
  return Object.freeze({ identity: identity(value.identity, 'exact directory identity'), location: selectedPathModule.resolve(location) });
}

function normalizeManifest(raw, selectedPathModule) {
  const value = onlyKeys(raw, new Set(['protocol', 'identity', 'location', 'object', 'digest', 'bytes']), 'exact directory manifest');
  if (value.protocol !== EXACT_DIRECTORY_PROTOCOL) throw new Error('exact directory manifest protocol is unsupported');
  const request = normalizeRequest({ identity: value.identity, location: value.location }, selectedPathModule);
  const object = onlyKeys(value.object, new Set(['device', 'inode', 'createdNs']), 'exact directory object');
  if (Object.values(object).some((entry) => typeof entry !== 'string' || !/^\d+$/u.test(entry))) {
    throw new Error('exact directory object is invalid');
  }
  if (value.bytes !== 0 || typeof value.digest !== 'string' || !SHA256.test(value.digest)) {
    throw new Error('exact directory manifest is invalid');
  }
  const body = Object.freeze({
    protocol: EXACT_DIRECTORY_PROTOCOL,
    identity: request.identity,
    location: request.location,
    object: Object.freeze({ ...object }),
    bytes: 0,
  });
  if (digest(body) !== value.digest) throw new Error('exact directory manifest digest changed');
  return Object.freeze({ ...body, digest: value.digest });
}

export class ExactDirectory {
  #platform;
  #path;
  #inspect;
  #canonicalize;
  #list;
  #remove;
  #isReparse;

  constructor({
    platform = process.platform,
    inspect = lstat,
    canonicalize = realpath,
    list = readdir,
    remove = rmdir,
    inspectReparse = null,
  } = {}) {
    if (!['win32', 'linux', 'darwin'].includes(platform)) throw new TypeError('exact directory platform is unsupported');
    for (const [port, name] of [[inspect, 'inspect'], [canonicalize, 'canonicalize'], [list, 'list'], [remove, 'remove']]) {
      if (typeof port !== 'function') throw new TypeError(`exact directory ${name} contract is invalid`);
    }
    if (inspectReparse != null && typeof inspectReparse !== 'function') throw new TypeError('exact directory reparse contract is invalid');
    if (platform === 'win32' && inspectReparse == null) throw new TypeError('Windows exact directory requires a reparse inspection contract');
    this.#platform = platform;
    this.#path = selectedPath(platform);
    this.#inspect = inspect;
    this.#canonicalize = canonicalize;
    this.#list = list;
    this.#remove = remove;
    this.#isReparse = inspectReparse ?? (async (_location, info) => info.isSymbolicLink());
  }

  async #observeReal(location, expected = null) {
    const info = await this.#inspect(location, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await this.#isReparse(location, info)) {
      throw new Error('exact directory is not a real directory');
    }
    const canonical = await this.#canonicalize(location);
    if (!(await sameFilesystemIdentity(location, canonical, { platform: this.#platform, inspect: this.#inspect }))) {
      throw new Error('exact directory uses filesystem indirection');
    }
    if (expected && !sameIdentity(expected, info)) throw new Error('exact directory identity changed');
    return info;
  }

  async plan(rawRequest) {
    const request = normalizeRequest(rawRequest, this.#path);
    const info = await this.#observeReal(request.location);
    const body = Object.freeze({
      protocol: EXACT_DIRECTORY_PROTOCOL,
      identity: request.identity,
      location: request.location,
      object: observedIdentity(info),
      bytes: 0,
    });
    return Object.freeze({ ...body, digest: digest(body) });
  }

  async observe(rawManifest) {
    const manifest = normalizeManifest(rawManifest, this.#path);
    try {
      await this.#observeReal(manifest.location, manifest.object);
      return Object.freeze({ identity: manifest.identity, state: 'present', retryable: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ identity: manifest.identity, state: 'absent', retryable: false });
      return Object.freeze({ identity: manifest.identity, state: 'ambiguous', retryable: false });
    }
  }

  async remove(rawManifest) {
    const manifest = normalizeManifest(rawManifest, this.#path);
    const before = await this.observe(manifest);
    if (before.state === 'ambiguous') throw new Error('exact directory cannot remove ambiguous state');
    if (before.state === 'absent') return Object.freeze({ identity: manifest.identity, removed: false, absent: true });
    await this.#observeReal(manifest.location, manifest.object);
    if ((await this.#list(manifest.location)).length !== 0) throw new Error('exact directory is not empty');
    await this.#remove(manifest.location);
    const after = await this.observe(manifest);
    if (after.state !== 'absent') throw new Error('exact directory did not reconcile to absence');
    return Object.freeze({ identity: manifest.identity, removed: true, absent: false });
  }
}

export function createExactDirectory(options) {
  return new ExactDirectory(options);
}
