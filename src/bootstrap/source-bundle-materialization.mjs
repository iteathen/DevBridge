import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import {
  sameFilesystemIdentity,
  sameObservedFilesystemIdentity,
} from '../runtime/local-filesystem-identity.js';
import { immutableObjectSetDigest } from '../runtime/immutable-object-set.js';
import { verifySourceBundleReleaseInput } from './source-bundle-release-input.mjs';

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

async function sameCheckoutRoot(left, right) {
  try { return await sameFilesystemIdentity(left, right); }
  catch { return false; }
}

async function observeExactObject(location, expected) {
  if (typeof location !== 'string' || !path.isAbsolute(location) || location.includes('\0')) {
    fail('source-bundle acquisition object location is invalid');
  }
  const before = await lstat(location, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expected.size)) {
    fail('source-bundle cache object shape does not match authority');
  }
  const handle = await open(location, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) fail('source-bundle cache object changed while opening');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let offset = 0;
    while (offset < expected.size) {
      const requested = Math.min(buffer.length, expected.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead !== requested) fail('source-bundle cache object ended while reading');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) fail('source-bundle cache object grew while reading');
    const after = await lstat(location, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(held, after)) {
      fail('source-bundle cache object changed while reading');
    }
    if (hash.digest('hex') !== expected.sha256) fail('source-bundle cache object digest does not match authority');
    return Object.freeze({ location: path.resolve(location), size: expected.size, sha256: expected.sha256 });
  } finally { await handle.close(); }
}

export class SourceBundleMaterialization {
  #acquisition;
  #checkout;

  constructor({ acquisition, checkout } = {}) {
    if (!acquisition || typeof acquisition.ensure !== 'function') throw new TypeError('source-bundle acquisition port is invalid');
    if (!checkout || typeof checkout.materialize !== 'function') throw new TypeError('source-bundle checkout port is invalid');
    this.#acquisition = acquisition;
    this.#checkout = checkout;
  }

  async prepare(raw) {
    const input = exactObject(raw, new Set(['authority', 'destination', 'signal']), 'source-bundle materialization');
    if (typeof input.destination !== 'string' || !path.isAbsolute(input.destination) || input.destination.includes('\0')) {
      throw new TypeError('source-bundle destination is invalid');
    }
    const authority = verifySourceBundleReleaseInput(input.authority);
    const acquired = await this.#acquisition.ensure({ descriptor: authority.descriptor, signal: input.signal ?? null });
    if (acquired?.subject !== authority.descriptor.subject
        || acquired?.descriptorSha256 !== authority.descriptorSha256
        || acquired.descriptorSha256 !== immutableObjectSetDigest(authority.descriptor)) {
      fail('source-bundle acquisition descriptor evidence does not match authority');
    }
    const expected = authority.descriptor.objects[0];
    if (!Array.isArray(acquired.objects) || acquired.objects.length !== 1) fail('source-bundle acquisition object evidence is invalid');
    const object = acquired.objects[0];
    if (object?.name !== expected.name || object?.size !== expected.size || object?.sha256 !== expected.sha256) {
      fail('source-bundle acquisition object evidence does not match authority');
    }
    const bundle = await observeExactObject(object.location, expected);
    const result = await this.#checkout.materialize({
      bundle,
      destination: path.resolve(input.destination),
      head: authority.head,
      tree: authority.tree,
      signal: input.signal ?? null,
    });
    const destination = path.resolve(input.destination);
    const rootValid = typeof result?.root === 'string' && path.isAbsolute(result.root);
    const rootMatches = rootValid && await sameCheckoutRoot(result.root, destination);
    if (result?.head !== authority.head || result?.tree !== authority.tree
        || !rootMatches) {
      fail('source-bundle checkout evidence does not match authority');
    }
    return Object.freeze({
      head: authority.head,
      tree: authority.tree,
      root: destination,
      releaseId: authority.releaseId,
      sequence: authority.sequence,
      manifestSha256: authority.manifestSha256,
      keyId: authority.keyId,
      objectSha256: expected.sha256,
    });
  }
}
