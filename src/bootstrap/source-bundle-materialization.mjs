import path from 'node:path';
import { reobserveImmutableObjectAcquisition } from '../runtime/immutable-object-acquisition-evidence.js';
import { sameFilesystemIdentity } from '../runtime/local-filesystem-identity.js';
import { verifySourceBundleReleaseInput } from './source-bundle-release-input.mjs';

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

async function sameCheckoutRoot(left, right) {
  try { return await sameFilesystemIdentity(left, right); }
  catch { return false; }
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
    const observed = await reobserveImmutableObjectAcquisition({
      descriptor: authority.descriptor,
      evidence: acquired,
      signal: input.signal ?? null,
    });
    const expected = authority.descriptor.objects[0];
    if (observed.descriptorSha256 !== authority.descriptorSha256 || observed.objects.length !== 1) {
      fail('source-bundle acquisition descriptor evidence does not match authority');
    }
    const bundle = observed.objects[0];
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
