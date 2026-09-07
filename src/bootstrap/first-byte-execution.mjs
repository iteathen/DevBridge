import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { sameObservedFilesystemIdentity } from '../runtime/local-filesystem-identity.js';
import { immutableObjectSetDigest } from '../runtime/immutable-object-set.js';
import { verifyFirstByteReleaseInput } from './first-byte-release-input.mjs';

const IMPORT_MARKER = Symbol.for('devbridge.first-byte-parent');

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readExactObject(location, expected) {
  if (typeof location !== 'string' || !path.isAbsolute(location) || location.includes('\0')) {
    fail('first-byte acquisition object location is invalid');
  }
  const before = await lstat(location, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expected.size)) {
    fail('first-byte cache object shape does not match authority');
  }
  const handle = await open(location, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) fail('first-byte cache object changed while opening');
    const bytes = await handle.readFile();
    const after = await lstat(location, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(held, after)) {
      fail('first-byte cache object changed while reading');
    }
    if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      fail('first-byte cache object digest does not match authority');
    }
    return bytes;
  } finally { await handle.close(); }
}

async function defaultLoadModule(bytes) {
  if (Object.hasOwn(globalThis, IMPORT_MARKER)) fail('first-byte import marker is already active');
  Object.defineProperty(globalThis, IMPORT_MARKER, { value: true, configurable: true });
  try {
    const digest = createHash('sha256').update(bytes).digest('hex');
    return await import(`data:text/javascript;base64,${bytes.toString('base64')}#${digest}`);
  } finally { delete globalThis[IMPORT_MARKER]; }
}

function normalizeArguments(raw) {
  if (!Array.isArray(raw) || raw.length > 128) throw new TypeError('first-byte bootstrap arguments are invalid');
  return Object.freeze(raw.map((value) => {
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
      throw new TypeError('first-byte bootstrap argument is invalid');
    }
    return value;
  }));
}

export class FirstByteBootstrapExecution {
  #acquisition;
  #loadModule;

  constructor({ acquisition, loadModule = defaultLoadModule } = {}) {
    if (!acquisition || typeof acquisition.ensure !== 'function') throw new TypeError('first-byte acquisition port is invalid');
    if (typeof loadModule !== 'function') throw new TypeError('first-byte module loader is invalid');
    this.#acquisition = acquisition;
    this.#loadModule = loadModule;
  }

  async run(raw) {
    const input = exactObject(raw, new Set(['authority', 'argv', 'signal']), 'first-byte execution');
    const authority = verifyFirstByteReleaseInput(input.authority);
    const argv = normalizeArguments(input.argv);
    const acquired = await this.#acquisition.ensure({ descriptor: authority.descriptor, signal: input.signal ?? null });
    if (acquired?.subject !== authority.descriptor.subject
        || acquired?.descriptorSha256 !== authority.descriptorSha256
        || acquired.descriptorSha256 !== immutableObjectSetDigest(authority.descriptor)) {
      fail('first-byte acquisition descriptor evidence does not match authority');
    }
    const expected = authority.descriptor.objects[0];
    if (!Array.isArray(acquired.objects) || acquired.objects.length !== 1) fail('first-byte acquisition object evidence is invalid');
    const object = acquired.objects[0];
    if (object?.name !== expected.name || object?.size !== expected.size || object?.sha256 !== expected.sha256) {
      fail('first-byte acquisition object evidence does not match authority');
    }
    const bytes = await readExactObject(object.location, expected);
    const module = await this.#loadModule(bytes);
    if (!module || typeof module.runZeroStateBootstrap !== 'function') fail('first-byte bootstrap module contract is unavailable');
    const bootstrap = await module.runZeroStateBootstrap(argv);
    if (!Number.isInteger(bootstrap?.status)) fail('first-byte bootstrap exited without a bounded status code');
    return Object.freeze({
      status: bootstrap.status,
      bootstrap,
      head: authority.head,
      releaseId: authority.releaseId,
      sequence: authority.sequence,
      manifestSha256: authority.manifestSha256,
      keyId: authority.keyId,
      objectSha256: expected.sha256,
    });
  }
}

export { IMPORT_MARKER };
