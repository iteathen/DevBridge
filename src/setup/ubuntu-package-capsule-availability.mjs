import { reobserveImmutableObjectAcquisition } from '../runtime/immutable-object-acquisition-evidence.js';
import { verifyUbuntuPackageCapsuleReleaseInput } from './ubuntu-package-capsule-release-input.mjs';

export const UBUNTU_PACKAGE_CAPSULE_AVAILABILITY_PROTOCOL = 'devbridge/ubuntu-package-capsule-availability-v1';

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function signalShape(signal) {
  if (signal != null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError('Ubuntu package-capsule availability signal is invalid');
  }
  return signal ?? null;
}

function interrupted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Ubuntu package-capsule availability was interrupted');
}

function copyAuthority(raw) {
  const value = exactObject(raw, new Set([
    'manifestBytes', 'publicKeyBytes', 'expectedManifestSha256', 'expectedPublicKeySha256', 'expectedKeyId',
  ]), 'Ubuntu package-capsule availability authority');
  if (!(value.manifestBytes instanceof Uint8Array) || !(value.publicKeyBytes instanceof Uint8Array)) {
    throw new TypeError('Ubuntu package-capsule availability authority bytes are invalid');
  }
  return Object.freeze({
    manifestBytes: Buffer.from(value.manifestBytes),
    publicKeyBytes: Buffer.from(value.publicKeyBytes),
    expectedManifestSha256: value.expectedManifestSha256,
    expectedPublicKeySha256: value.expectedPublicKeySha256,
    expectedKeyId: value.expectedKeyId,
  });
}

export class UbuntuPackageCapsuleAvailability {
  #acquisition;
  #release;

  constructor(raw = {}) {
    const value = exactObject(raw, new Set(['authority', 'acquisition']), 'Ubuntu package-capsule availability options');
    if (!value.acquisition || typeof value.acquisition.ensure !== 'function') {
      throw new TypeError('Ubuntu package-capsule acquisition port is invalid');
    }
    this.#release = verifyUbuntuPackageCapsuleReleaseInput(copyAuthority(value.authority));
    this.#acquisition = value.acquisition;
  }

  async prepare(raw = {}) {
    const request = exactObject(raw, new Set(['signal']), 'Ubuntu package-capsule availability request');
    const signal = signalShape(request.signal);
    interrupted(signal);
    const descriptors = [
      ['metadata', this.#release.metadata.descriptor],
      ['binaries', this.#release.binaries.descriptor],
      ['sources', this.#release.sources.descriptor],
    ];
    const groups = {};
    for (const [name, descriptor] of descriptors) {
      interrupted(signal);
      const evidence = await this.#acquisition.ensure({ descriptor, signal });
      groups[name] = (await reobserveImmutableObjectAcquisition({ descriptor, evidence, signal })).objects;
    }
    return Object.freeze({
      protocol: UBUNTU_PACKAGE_CAPSULE_AVAILABILITY_PROTOCOL,
      release: this.#release,
      objects: Object.freeze(groups),
    });
  }
}
