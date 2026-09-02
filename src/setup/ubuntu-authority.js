import { gunzipSync } from 'node:zlib';
import { createGuestImagePayload } from '../guest/image-payload.js';
import { normalizeUbuntuConstructionAuthority } from '../runtime/image-builders/ubuntu-construction-authority.js';
import { comparePackageVersions } from './package-version.js';

const SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const PACKAGE_NAMES = Object.freeze(['build-essential', 'cmake', 'git', 'linux-cloud-tools-virtual', 'nodejs', 'npm', 'openssh-server']);
const COMPONENTS = Object.freeze(['main', 'universe']);
const POCKETS = Object.freeze(['resolute', 'resolute-updates', 'resolute-security']);
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_LAG_MS = 48 * 60 * 60 * 1000;

const SOURCE = Object.freeze({
  release: '26.04',
  codename: 'resolute',
  architecture: 'amd64',
  mediaName: 'ubuntu-26.04-live-server-amd64.iso',
  mediaSha256: 'dec49008a71f6098d0bcfc822021f4d042d5f2db279e4d75bdd981304f1ca5d9',
  mediaBytes: 2_918_598_656,
  signerFingerprint: '843938DF228D22F7B3742BC0D94AA3F0EFE21092',
});

const OUTPUT = Object.freeze({ profile: 'linux-development', generation: 'ubuntu-2604-production-v7', bootstrap: 'guest-image-v1' });
const OUTPUT_PAYLOAD_GENERATION = 'guest-image-6c102cff53ad6d9f10f03530';
const RECIPE_GENERATION = 'ubuntu-2604-autoinstall-v11';
const PACKAGE_GENERATION = 'ubuntu-2604-tools-v4';

const BOOT_PATCH = Object.freeze({
  before: 'Try or Install Ubuntu Server" {\n    set gfxpayload=keep\n    linux  /casper/vmlinuz ',
  after: 'Automated Install" {\n    set gfxpayload=keep\n    linux  /casper/vmlinuz autoinstall',
});

function snapshotTimestamp(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `${year}${month}${day}T${hour}0000Z`;
}

export function defaultUbuntuPackageSnapshot(now = new Date()) {
  const value = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(value)) throw new TypeError('Ubuntu package snapshot clock is invalid');
  return snapshotTimestamp(new Date(value - SNAPSHOT_LAG_MS));
}

function packageRecords(text, requested) {
  const found = new Map();
  for (const paragraph of text.split(/\n\s*\n/u)) {
    let name = null;
    let version = null;
    for (const line of paragraph.split('\n')) {
      if (line.startsWith('Package: ')) name = line.slice('Package: '.length).trim();
      else if (line.startsWith('Version: ')) version = line.slice('Version: '.length).trim();
    }
    if (!name || !version || !requested.has(name)) continue;
    const previous = found.get(name);
    if (previous && previous !== version) throw new Error(`Ubuntu snapshot contains ambiguous versions for ${name}: ${previous}, ${version}`);
    found.set(name, version);
  }
  return found;
}

async function fetchPackageIndex(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response?.ok) throw new Error(`Ubuntu snapshot package index request failed (${response?.status ?? 'unknown'}): ${url}`);
  const length = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isFinite(length) && length > MAX_COMPRESSED_BYTES) throw new Error('Ubuntu snapshot package index exceeds the compressed size bound');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > MAX_COMPRESSED_BYTES) throw new Error('Ubuntu snapshot package index has an invalid compressed size');
  try { return gunzipSync(bytes, { maxOutputLength: MAX_INDEX_BYTES }).toString('utf8'); }
  catch (error) { throw new Error(`Ubuntu snapshot package index could not be decoded: ${error.message}`); }
}

export async function resolveUbuntuPackagePins({ snapshot, fetchImpl = globalThis.fetch } = {}) {
  if (typeof snapshot !== 'string' || !SNAPSHOT.test(snapshot)) throw new TypeError('Ubuntu package snapshot is invalid');
  if (typeof fetchImpl !== 'function') throw new TypeError('Ubuntu package snapshot fetch implementation is invalid');
  const requested = new Set(PACKAGE_NAMES);
  const versions = new Map();
  for (const pocket of POCKETS) {
    for (const component of COMPONENTS) {
      const url = `https://snapshot.ubuntu.com/ubuntu/${snapshot}/dists/${pocket}/${component}/binary-${SOURCE.architecture}/Packages.gz`;
      const records = packageRecords(await fetchPackageIndex(url, fetchImpl), requested);
      for (const [name, version] of records) {
        const previous = versions.get(name);
        if (!previous || comparePackageVersions(version, previous) > 0) versions.set(name, version);
      }
    }
  }
  const missing = PACKAGE_NAMES.filter((name) => !versions.has(name));
  if (missing.length > 0) throw new Error(`Ubuntu snapshot does not contain required setup packages: ${missing.join(', ')}`);
  return Object.freeze(PACKAGE_NAMES.map((name) => Object.freeze({ name, version: versions.get(name) })));
}

function authorityFrom({ snapshot, packages, payloadGeneration }) {
  if (payloadGeneration !== OUTPUT_PAYLOAD_GENERATION) {
    throw new Error('current guest payload generation is not bound to the Ubuntu output generation');
  }
  return Object.freeze({
    protocol: 'devbridge/ubuntu-construction-authority-v1',
    source: Object.freeze({
      protocol: 'devbridge/ubuntu-release-media-v1',
      release: SOURCE.release,
      architecture: SOURCE.architecture,
      media: Object.freeze({
        url: `https://releases.ubuntu.com/${SOURCE.release}/${SOURCE.mediaName}`,
        name: SOURCE.mediaName,
        sha256: SOURCE.mediaSha256,
        bytes: SOURCE.mediaBytes,
      }),
      checksums: Object.freeze({
        manifestUrl: `https://releases.ubuntu.com/${SOURCE.release}/SHA256SUMS`,
        signatureUrl: `https://releases.ubuntu.com/${SOURCE.release}/SHA256SUMS.gpg`,
        signerFingerprint: SOURCE.signerFingerprint,
      }),
    }),
    recipe: Object.freeze({
      protocol: 'devbridge/ubuntu-autoinstall-recipe-v1',
      sourceSha256: SOURCE.mediaSha256,
      generation: RECIPE_GENERATION,
      patches: Object.freeze([Object.freeze({ id: 'boot-trigger', occurrences: 2, before: BOOT_PATCH.before, after: BOOT_PATCH.after })]),
    }),
    packages: Object.freeze({
      generation: PACKAGE_GENERATION,
      snapshot,
      packages: Object.freeze(packages.map((entry) => Object.freeze({ ...entry }))),
    }),
    payload: Object.freeze({ generation: payloadGeneration }),
    qualification: Object.freeze({
      commands: Object.freeze(['hv_fcopy_uio_daemon', 'hv_kvp_daemon', 'make']),
      services: Object.freeze(['hv-fcopy-daemon.service']),
    }),
    output: OUTPUT,
  });
}

export async function createUbuntuSetupAuthority({
  snapshot,
  fetchImpl = globalThis.fetch,
  payloadFactory = createGuestImagePayload,
} = {}) {
  if (typeof payloadFactory !== 'function') throw new TypeError('Ubuntu setup payload factory is invalid');
  if (Buffer.byteLength(BOOT_PATCH.before, 'utf8') !== 83 || Buffer.byteLength(BOOT_PATCH.after, 'utf8') !== 83) {
    throw new Error('Ubuntu setup boot recipe no longer preserves the verified 83-byte patch length');
  }
  const [packages, payload] = await Promise.all([
    resolveUbuntuPackagePins({ snapshot, fetchImpl }),
    payloadFactory(),
  ]);
  if (!payload || typeof payload.generation !== 'string' || payload.generation.length === 0) throw new Error('current guest payload generation is unavailable');
  return authorityFrom({ snapshot, packages, payloadGeneration: payload.generation });
}

export async function deriveCurrentUbuntuSetupAuthority({
  snapshot,
  authorities,
  payloadFactory = createGuestImagePayload,
} = {}) {
  if (typeof snapshot !== 'string' || !SNAPSHOT.test(snapshot)) throw new TypeError('Ubuntu package snapshot is invalid');
  if (!Array.isArray(authorities) || authorities.length > 4096) throw new TypeError('Ubuntu setup authority inventory is invalid');
  if (typeof payloadFactory !== 'function') throw new TypeError('Ubuntu setup payload factory is invalid');
  const payload = await payloadFactory();
  if (!payload || typeof payload.generation !== 'string' || payload.generation.length === 0) throw new Error('current guest payload generation is unavailable');
  const expectedNames = JSON.stringify(PACKAGE_NAMES);
  const packageSets = new Map();
  for (const raw of authorities) {
    const authority = normalizeUbuntuConstructionAuthority(raw);
    if (authority.packages.snapshot !== snapshot || authority.packages.generation !== PACKAGE_GENERATION
        || JSON.stringify(authority.packages.packages.map((entry) => entry.name)) !== expectedNames) continue;
    packageSets.set(JSON.stringify(authority.packages.packages), authority.packages.packages);
  }
  if (packageSets.size !== 1) throw new Error(`current Ubuntu setup package authority expected one exact stored set but observed ${packageSets.size}`);
  return normalizeUbuntuConstructionAuthority(authorityFrom({
    snapshot,
    packages: packageSets.values().next().value,
    payloadGeneration: payload.generation,
  }));
}

export { BOOT_PATCH as UBUNTU_SETUP_BOOT_PATCH, OUTPUT as UBUNTU_SETUP_OUTPUT, SOURCE as UBUNTU_SETUP_SOURCE_POLICY };
