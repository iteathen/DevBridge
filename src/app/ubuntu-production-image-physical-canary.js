import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createGuestImagePayload } from '../guest/image-payload.js';
import { createCanonicalImageCanary } from '../runtime/image-builders/canonical-image-canary.js';
import { createUbuntuAutoinstallMediaPreparer } from '../runtime/image-builders/ubuntu-autoinstall-media.js';
import { createUbuntuConstructionAuthorityCatalog } from '../runtime/image-builders/ubuntu-construction-authority-catalog.js';
import {
  normalizeUbuntuConstructionAuthority,
  ubuntuConstructionAuthoritySubject,
} from '../runtime/image-builders/ubuntu-construction-authority.js';
import { createUbuntuProductionImageCanaryComposition } from '../runtime/image-builders/ubuntu-production-image-canary-composition.js';
import { createUbuntuProductionImageQualification } from '../runtime/image-builders/ubuntu-production-qualification.js';
import { createUbuntuProductionSeedFactory } from '../runtime/image-builders/ubuntu-production-seed.js';
import { createUbuntuReleaseMediaSource } from '../runtime/image-sources/ubuntu-release-media.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { createDetachedSignatureVerifier } from '../runtime/detached-signature-verifier.js';
import { createHttpsFileDownload } from '../runtime/https-file-download.js';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';
import { HyperVEnvironmentBootstrap } from '../runtime/providers/hyperv-environment-bootstrap.js';
import { HyperVEnvironmentBridge } from '../runtime/providers/hyperv-environment-bridge.js';
import { createHyperVEnvironmentLocation } from '../runtime/providers/hyperv-environment-location.js';
import { createHyperVImageConstruction } from '../runtime/providers/hyperv-image-construction.js';
import { createWindowsImapiNoCloudSeedWriter } from '../runtime/providers/windows-imapi-nocloud-seed.js';
import { createWindowsProductionImageCanaryPreflight } from '../runtime/providers/windows-production-image-canary-preflight.js';
import { createSshAccessMaterial } from '../runtime/ssh-access-material.js';
import { createSshAccessProbe } from '../runtime/ssh-access-probe.js';
import { createSshImageFinalization } from '../runtime/ssh-image-finalization.js';
import { JsonStateStore } from '../state/json-state-store.js';
import { createCanonicalImageCanaryStateStore } from '../state/canonical-image-canary-state-store.js';
import { createUbuntuConstructionAuthorityStateStore } from '../state/ubuntu-construction-authority-state-store.js';
import { createSubjectPreparationAdapter } from './subject-preparation-adapter.js';
import { createEnvironmentFoundation } from './environment-foundation.js';

const CONFIG_PROTOCOL = 'devbridge/ubuntu-production-image-physical-canary-config-v1';
const STATUS_PROTOCOL = 'devbridge/ubuntu-production-image-physical-canary-status-v1';
const PREPARATION_PROTOCOL = 'devbridge/ubuntu-production-image-physical-preparation-v1';
const SOURCE_HOSTS = Object.freeze(['releases.ubuntu.com', 'cdimage.ubuntu.com']);
const SHA256 = /^[a-f0-9]{64}$/u;
const SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;
const MIN_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MIN_DISK_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DISK_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
const MAX_PROCESSORS = 256;
const MAX_ACCESS_SEED_BYTES = 128 * 1024;
const MAX_ADVANCES = 16;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute local path`);
  return path.resolve(value);
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeConfig(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'stateDirectory', 'keyring', 'authority', 'resources']), 'physical canary config');
  if (value.protocol !== CONFIG_PROTOCOL) throw new TypeError('physical canary config protocol is unsupported');
  const resources = onlyKeys(value.resources, new Set(['memoryBytes', 'processorCount', 'diskBytes']), 'physical canary resources');
  return Object.freeze({
    protocol: CONFIG_PROTOCOL,
    stateDirectory: absolutePath(value.stateDirectory, 'physical canary stateDirectory'),
    keyring: absolutePath(value.keyring, 'physical canary keyring'),
    authority: normalizeUbuntuConstructionAuthority(value.authority),
    resources: Object.freeze({
      memoryBytes: boundedInteger(resources.memoryBytes, MIN_MEMORY_BYTES, MAX_MEMORY_BYTES, 'physical canary resources.memoryBytes'),
      processorCount: boundedInteger(resources.processorCount, 1, MAX_PROCESSORS, 'physical canary resources.processorCount'),
      diskBytes: boundedInteger(resources.diskBytes, MIN_DISK_BYTES, MAX_DISK_BYTES, 'physical canary resources.diskBytes'),
    }),
  });
}

function pathsFor(config, subject) {
  const root = path.join(config.stateDirectory, 'production-image-canary');
  const sourceRoot = path.join(root, 'source');
  const subjectRoot = path.join(sourceRoot, subject);
  return Object.freeze({
    root,
    runLock: path.join(root, 'run.lock'),
    authorityFile: path.join(root, 'authority.json'),
    journalFile: path.join(root, 'journal.json'),
    preparationFile: path.join(root, 'preparation.json'),
    sourceRoot,
    subjectRoot,
    releaseCacheDirectory: path.join(root, 'release-cache'),
    releaseDirectory: path.join(subjectRoot, 'release'),
    preparedDirectory: path.join(subjectRoot, 'prepared'),
    constructionDirectory: path.join(root, 'construction'),
    outputRoot: path.join(root, 'output'),
    accessRoot: path.join(root, 'access'),
    foundationRoot: path.join(config.stateDirectory, 'environment-foundation'),
  });
}

async function sha256File(location) {
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

async function exactRegularFile(location, expected, name) {
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a real regular file`);
  const measured = await sha256File(location);
  if (expected?.bytes != null && measured.bytes !== expected.bytes) throw new Error(`${name} byte count changed`);
  if (expected?.sha256 != null && measured.sha256 !== expected.sha256) throw new Error(`${name} digest changed`);
  return measured;
}

function safeString(value, name, maxBytes = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is invalid`);
  return value;
}

function receiptMedia(raw, name) {
  const value = onlyKeys(raw, new Set(['location', 'bytes', 'sha256']), name);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) throw new TypeError(`${name}.bytes is invalid`);
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) throw new TypeError(`${name}.sha256 is invalid`);
  return Object.freeze({ location: absolutePath(value.location, `${name}.location`), bytes: value.bytes, sha256: value.sha256 });
}

function receiptNetwork(raw) {
  const value = onlyKeys(raw, new Set(['reference', 'proof', 'address', 'prefixLength', 'gateway', 'dns']), 'physical preparation network');
  if (!Array.isArray(value.dns) || value.dns.length < 1 || value.dns.length > 4 || value.dns.some((entry) => typeof entry !== 'string' || !IPV4.test(entry))) throw new TypeError('physical preparation network.dns is invalid');
  if (typeof value.address !== 'string' || !IPV4.test(value.address) || typeof value.gateway !== 'string' || !IPV4.test(value.gateway)) throw new TypeError('physical preparation network address is invalid');
  if (!Number.isInteger(value.prefixLength) || value.prefixLength < 8 || value.prefixLength > 30) throw new TypeError('physical preparation network prefixLength is invalid');
  return Object.freeze({
    reference: safeString(value.reference, 'physical preparation network.reference', 160),
    proof: safeString(value.proof, 'physical preparation network.proof', 2048),
    address: value.address,
    prefixLength: value.prefixLength,
    gateway: value.gateway,
    dns: Object.freeze([...value.dns]),
  });
}

function receiptAccess(raw) {
  const value = onlyKeys(raw, new Set(['family', 'user', 'identityFile', 'knownHostsFile', 'identitySha256', 'knownHostsSha256']), 'physical preparation access');
  if (value.family !== 'linux') throw new TypeError('physical preparation access family is invalid');
  if (typeof value.identitySha256 !== 'string' || !SHA256.test(value.identitySha256) || typeof value.knownHostsSha256 !== 'string' || !SHA256.test(value.knownHostsSha256)) throw new TypeError('physical preparation access digest is invalid');
  return Object.freeze({
    family: 'linux',
    user: safeString(value.user, 'physical preparation access.user', 128),
    identityFile: absolutePath(value.identityFile, 'physical preparation access.identityFile'),
    knownHostsFile: absolutePath(value.knownHostsFile, 'physical preparation access.knownHostsFile'),
    identitySha256: value.identitySha256,
    knownHostsSha256: value.knownHostsSha256,
  });
}

function normalizePreparation(raw, config, subject) {
  const value = onlyKeys(raw, new Set(['protocol', 'identity', 'payloadGeneration', 'packageGeneration', 'packageSnapshot', 'resources', 'network', 'installer', 'seed', 'access']), 'physical preparation');
  if (value.protocol !== PREPARATION_PROTOCOL || value.identity !== subject) throw new Error('physical preparation identity changed');
  if (value.payloadGeneration !== config.authority.payload.generation || value.packageGeneration !== config.authority.packages.generation) throw new Error('physical preparation generation changed');
  if (typeof value.packageSnapshot !== 'string' || !SNAPSHOT.test(value.packageSnapshot) || value.packageSnapshot !== config.authority.packages.snapshot) throw new Error('physical preparation package snapshot changed');
  const resources = onlyKeys(value.resources, new Set(['memoryBytes', 'processorCount', 'diskBytes']), 'physical preparation resources');
  if (resources.memoryBytes !== config.resources.memoryBytes || resources.processorCount !== config.resources.processorCount || resources.diskBytes !== config.resources.diskBytes) throw new Error('physical preparation resource policy changed');
  return Object.freeze({
    protocol: PREPARATION_PROTOCOL,
    identity: subject,
    payloadGeneration: value.payloadGeneration,
    packageGeneration: value.packageGeneration,
    packageSnapshot: value.packageSnapshot,
    resources: config.resources,
    network: receiptNetwork(value.network),
    installer: receiptMedia(value.installer, 'physical preparation installer'),
    seed: receiptMedia(value.seed, 'physical preparation seed'),
    access: receiptAccess(value.access),
  });
}

async function verifyPreparation(receipt) {
  await exactRegularFile(receipt.installer.location, receipt.installer, 'physical preparation installer');
  await exactRegularFile(receipt.seed.location, receipt.seed, 'physical preparation seed');
  const identity = await exactRegularFile(receipt.access.identityFile, null, 'physical preparation SSH identity');
  const knownHosts = await exactRegularFile(receipt.access.knownHostsFile, null, 'physical preparation known-hosts');
  if (identity.sha256 !== receipt.access.identitySha256) throw new Error('physical preparation SSH identity changed');
  if (knownHosts.sha256 !== receipt.access.knownHostsSha256) throw new Error('physical preparation known-hosts changed');
  return receipt;
}

async function accessSeed(location, subject) {
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_ACCESS_SEED_BYTES) throw new Error('physical preparation access seed is invalid');
  const value = JSON.parse(await readFile(location, 'utf8'));
  onlyKeys(value, new Set(['protocol', 'target', 'user', 'authorizedKey', 'hostPrivateKey', 'hostPublicKey', 'revision']), 'physical preparation access seed');
  if (value.protocol !== 'devbridge/linux-access-seed-v1' || value.target !== subject || value.revision !== 1) throw new Error('physical preparation access seed identity changed');
  return Object.freeze({
    user: safeString(value.user, 'physical preparation access seed user', 128),
    authorizedKey: safeString(value.authorizedKey, 'physical preparation authorized key', 1024),
    hostPrivateKey: safeString(value.hostPrivateKey, 'physical preparation host private key', 64 * 1024),
    hostPublicKey: safeString(value.hostPublicKey, 'physical preparation host public key', 1024),
  });
}

function neutralPayload(payload) {
  return Object.freeze({ generation: payload.generation, files: Object.freeze(payload.files.map((file) => Object.freeze({ ...file }))) });
}

function requestFor(config, subject, payload) {
  if (payload.generation !== config.authority.payload.generation) throw new Error('current guest payload generation does not match construction authority');
  return Object.freeze({
    identity: subject,
    work: Object.freeze({ subject }),
    check: Object.freeze({
      payloadGeneration: payload.generation,
      files: Object.freeze(payload.files.map((file) => Object.freeze({ path: file.path, sha256: file.sha256 }))),
      packageGeneration: config.authority.packages.generation,
      packageSnapshot: config.authority.packages.snapshot,
      packages: Object.freeze(config.authority.packages.packages.map((entry) => Object.freeze({ ...entry }))),
      commands: Object.freeze([...config.authority.qualification.commands]),
    }),
    output: Object.freeze({
      profile: config.authority.output.profile,
      generation: config.authority.output.generation,
      provenance: Object.freeze({
        origin: 'ubuntu-production-image-canary',
        authority: subject,
        source: config.authority.source.media.sha256,
        bootstrap: config.authority.output.bootstrap,
      }),
    }),
  });
}

function inspectionCanary(journal) {
  const unavailable = async () => { throw new Error('read-only canary inspection invoked a mutating contract'); };
  return createCanonicalImageCanary({
    journal,
    construction: { prepare: unavailable, observe: unavailable, start: unavailable, activate: unavailable, accept: unavailable, retain: unavailable },
    qualification: { probe: unavailable, finalize: unavailable },
    images: { publish: unavailable, verify: unavailable },
  });
}

function publicResult(subject, canary, { state = null, reason = null, preflight = null, authorityRegistered = null } = {}) {
  const selectedState = state ?? (canary?.complete ? 'completed' : canary?.blocked ? 'blocked' : canary?.phase ?? 'unavailable');
  return Object.freeze({
    protocol: STATUS_PROTOCOL,
    subject,
    state: selectedState,
    phase: canary?.phase ?? null,
    complete: canary?.complete === true,
    blocked: selectedState === 'blocked',
    reason: reason ?? canary?.reason ?? null,
    image: canary?.image ?? null,
    authorityRegistered,
    preflight,
  });
}

async function withRunLock(lockPath, work) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error('physical canary mutation is already active; remove run.lock only after confirming no operation is running');
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    await handle.sync();
    return await work();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function cleanupCompletedState({ paths, subject, invoke }) {
  const reasons = [];
  const addressOwner = new HyperVEnvironmentBootstrap({
    directory: path.join(paths.foundationRoot, 'bootstrap', 'attachment'),
    invoke,
    locate: async () => { throw new Error('completed cleanup must not locate a provider subject'); },
    connection: async () => { throw new Error('completed cleanup must not resolve guest access'); },
  });
  try { await addressOwner.releaseAddress(subject); }
  catch (error) { reasons.push(`network reservation cleanup failed: ${error.message}`); }
  const accessMaterial = createSshAccessMaterial({ directory: paths.accessRoot, invoke });
  try { await accessMaterial.discard(subject); }
  catch (error) { reasons.push(`SSH access cleanup failed: ${error.message}`); }
  return reasons.length === 0 ? null : reasons.join('; ');
}

async function createPhysicalRuntime({ config, subject, payload, paths, invoke, fetchImpl, catalog, preparationStore, signatureVerifierExecutable }) {
  const localIdentity = await loadOrCreateLocalIdentity({ directory: paths.foundationRoot });
  const providerLocation = createHyperVEnvironmentLocation(localIdentity);
  const networkIdentity = providerLocation.network();
  const foundation = await createEnvironmentFoundation({ stateDirectory: config.stateDirectory, platform: 'win32', invoke });
  const construction = createHyperVImageConstruction({
    directory: paths.constructionDirectory,
    sourceRoot: paths.sourceRoot,
    outputRoot: paths.outputRoot,
    identity: localIdentity,
    invoke,
  });
  const accessMaterial = createSshAccessMaterial({ directory: paths.accessRoot, invoke });
  const addressOwner = new HyperVEnvironmentBootstrap({
    directory: path.join(paths.foundationRoot, 'bootstrap', 'attachment'),
    invoke,
    locate: async (target) => Object.freeze({ ...providerLocation.environment(target), family: 'linux', network: networkIdentity }),
    connection: async (target) => accessMaterial.connection(target),
  });

  const preparationRequest = (receipt) => Object.freeze({
    identity: subject,
    installer: receipt.installer,
    seed: receipt.seed,
    memoryBytes: config.resources.memoryBytes,
    processorCount: config.resources.processorCount,
    diskBytes: config.resources.diskBytes,
    network: Object.freeze({ reference: receipt.network.reference, proof: receipt.network.proof }),
  });

  const loadReceipt = async () => {
    const raw = await preparationStore.get(subject);
    if (raw == null) return null;
    return verifyPreparation(normalizePreparation(raw, config, subject));
  };

  const ensureNetworkReceipt = async (receipt) => {
    await foundation.ensureStorage();
    await foundation.ensureNetwork();
    const lease = await addressOwner.reserveAddress(subject, networkIdentity);
    if (
      receipt.network.reference !== networkIdentity.reference
      || receipt.network.proof !== networkIdentity.proof
      || receipt.network.address !== lease.address
      || receipt.network.prefixLength !== lease.prefixLength
      || receipt.network.gateway !== lease.gateway
    ) throw new Error('physical preparation network identity changed');
    return receipt;
  };

  const freshReceipt = async (authority) => {
    const observed = await construction.status(subject);
    if (observed.phase !== 'absent') throw new Error('construction state exists without its physical preparation receipt');
    await rm(paths.subjectRoot, { recursive: true, force: true });
    await mkdir(paths.subjectRoot, { recursive: false, mode: 0o700 });
    let reserved = false;
    let preparedAccess = null;
    let lease = null;
    try {
      const download = createHttpsFileDownload({ fetchImpl, allowedHosts: SOURCE_HOSTS });
      const verifyManifest = createDetachedSignatureVerifier({ invoke, keyring: config.keyring, executable: signatureVerifierExecutable ?? undefined });
      const source = createUbuntuReleaseMediaSource({
        authorityLookup: async (reference) => {
          if (reference !== subject) throw new Error('release authority subject changed');
          const selected = await catalog.lookup(reference);
          if (!selected) throw new Error('release authority is unavailable');
          return selected.source;
        },
        download,
        verifyManifest,
        mediaCacheDirectory: paths.releaseCacheDirectory,
      });
      const seedFactory = createUbuntuProductionSeedFactory({
        payloadSet: async () => neutralPayload(payload),
        packageSet: async () => authority.packages,
      });
      const media = createUbuntuAutoinstallMediaPreparer({
        recipeLookup: async (reference) => {
          if (reference !== subject) throw new Error('autoinstall recipe subject changed');
          const selected = await catalog.lookup(reference);
          if (!selected) throw new Error('autoinstall recipe authority is unavailable');
          return selected.recipe;
        },
        seedFactory: async ({ recipeGeneration, sourceIdentity }) => {
          if (recipeGeneration !== authority.recipe.generation || sourceIdentity.sha256 !== authority.source.media.sha256) throw new Error('autoinstall seed basis changed');
          await foundation.ensureStorage();
          await foundation.ensureNetwork();
          lease = await addressOwner.reserveAddress(subject, networkIdentity);
          reserved = true;
          preparedAccess = await accessMaterial.prepare(subject);
          const keyMaterial = await accessSeed(preparedAccess.seedFile, subject);
          return seedFactory.create({
            identity: subject,
            address: lease.address,
            prefixLength: lease.prefixLength,
            gateway: lease.gateway,
            dns: lease.dns,
            authorizedKey: keyMaterial.authorizedKey,
            hostPrivateKey: keyMaterial.hostPrivateKey,
            hostPublicKey: keyMaterial.hostPublicKey,
          });
        },
        seedWriter: createWindowsImapiNoCloudSeedWriter({ invoke }),
      });
      const admitted = await source.acquire({ authorityRef: subject, destination: paths.releaseDirectory });
      const prepared = await media.prepare({ source: admitted, recipeRef: subject, destination: paths.preparedDirectory });
      if (!lease || !preparedAccess) throw new Error('physical preparation did not establish bounded host material');
      if (
        prepared.evidence?.seed?.payloadGeneration !== payload.generation
        || prepared.evidence?.seed?.packageGeneration !== authority.packages.generation
        || prepared.evidence?.seed?.packageSnapshot !== authority.packages.snapshot
      ) throw new Error('prepared seed evidence does not match construction authority');
      await rm(paths.releaseDirectory, { recursive: true, force: true });
      const baseAccess = preparedAccess.connection;
      const [identityEvidence, knownHostsEvidence] = await Promise.all([
        exactRegularFile(baseAccess.identityFile, null, 'physical preparation SSH identity'),
        exactRegularFile(baseAccess.knownHostsFile, null, 'physical preparation known-hosts'),
      ]);
      const receipt = Object.freeze({
        protocol: PREPARATION_PROTOCOL,
        identity: subject,
        payloadGeneration: payload.generation,
        packageGeneration: authority.packages.generation,
        packageSnapshot: authority.packages.snapshot,
        resources: config.resources,
        network: Object.freeze({ reference: networkIdentity.reference, proof: networkIdentity.proof, ...lease, dns: [...lease.dns] }),
        installer: Object.freeze({ ...prepared.installer }),
        seed: Object.freeze({ location: prepared.seed.location, bytes: prepared.seed.bytes, sha256: prepared.seed.sha256 }),
        access: Object.freeze({
          family: 'linux',
          user: baseAccess.user,
          identityFile: baseAccess.identityFile,
          knownHostsFile: baseAccess.knownHostsFile,
          identitySha256: identityEvidence.sha256,
          knownHostsSha256: knownHostsEvidence.sha256,
        }),
      });
      await preparationStore.set(subject, receipt);
      return receipt;
    } catch (error) {
      if (reserved) await addressOwner.releaseAddress(subject).catch(() => {});
      await accessMaterial.discard(subject).catch(() => {});
      await rm(paths.subjectRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      await preparedAccess?.cleanup().catch(() => {});
    }
  };

  const preparation = createSubjectPreparationAdapter({
    async resolve(reference) {
      if (reference !== subject) throw new Error('physical preparation subject changed');
      const authority = await catalog.lookup(reference);
      if (!authority) throw new Error('construction authority is unavailable');
      let receipt = await loadReceipt();
      if (receipt) receipt = await ensureNetworkReceipt(receipt);
      else receipt = await freshReceipt(authority);
      return preparationRequest(receipt);
    },
    apply: (request) => construction.prepare(request),
  });

  const access = async (target) => {
    if (target !== subject) throw new Error('physical canary access target changed');
    const receipt = await loadReceipt();
    if (!receipt) throw new Error('physical canary access is unavailable before preparation');
    return Object.freeze({ family: 'linux', user: receipt.access.user, address: receipt.network.address, identityFile: receipt.access.identityFile, knownHostsFile: receipt.access.knownHostsFile });
  };
  const bridge = new HyperVEnvironmentBridge({ invoke, access, locate: (target) => construction.locate(target) });
  const finalizer = createSshImageFinalization({ invoke, access });
  const qualification = createUbuntuProductionImageQualification({ bridge, finalizer });
  const journal = createCanonicalImageCanaryStateStore(paths.journalFile);
  const canary = createUbuntuProductionImageCanaryComposition({ journal, preparation, construction, qualification, foundation });
  return Object.freeze({
    canary,
    construction,
    access,
    accessProbe: createSshAccessProbe({ invoke }),
    addressOwner,
    accessMaterial,
  });
}

export function createUbuntuProductionImagePhysicalCanary(rawConfig, {
  platform = process.platform,
  invoke = invokeCommand,
  fetchImpl = globalThis.fetch,
  payloadFactory = createGuestImagePayload,
  preflight = null,
  runtimeFactory = null,
  signatureVerifierExecutable = null,
} = {}) {
  const config = normalizeConfig(rawConfig);
  if (typeof invoke !== 'function') throw new TypeError('physical canary invocation contract is invalid');
  if (typeof payloadFactory !== 'function') throw new TypeError('physical canary payload factory is invalid');
  if (runtimeFactory != null && typeof runtimeFactory !== 'function') throw new TypeError('physical canary runtime factory is invalid');
  if (signatureVerifierExecutable != null && (typeof signatureVerifierExecutable !== 'string' || signatureVerifierExecutable.length === 0 || signatureVerifierExecutable.includes('\0') || !path.win32.isAbsolute(signatureVerifierExecutable))) throw new TypeError('physical canary signature-verifier binding is invalid');
  const subject = ubuntuConstructionAuthoritySubject(config.authority);
  const paths = pathsFor(config, subject);
  const authorityStore = createUbuntuConstructionAuthorityStateStore(paths.authorityFile);
  const catalog = createUbuntuConstructionAuthorityCatalog({ store: authorityStore });
  const journal = createCanonicalImageCanaryStateStore(paths.journalFile);
  const preparationStore = new JsonStateStore(paths.preparationFile);
  const selectedPreflight = preflight ?? createWindowsProductionImageCanaryPreflight({ invoke, platform, signatureVerifierExecutable });
  if (!selectedPreflight || typeof selectedPreflight.inspect !== 'function') throw new TypeError('physical canary preflight contract is incomplete');

  const status = async () => {
    const payload = await payloadFactory();
    const payloadMatches = payload?.generation === config.authority.payload.generation;
    const preflightResult = await selectedPreflight.inspect({
      stateDirectory: config.stateDirectory,
      keyring: config.keyring,
      memoryBytes: config.resources.memoryBytes,
      diskBytes: config.resources.diskBytes,
      sourceBytes: config.authority.source.media.bytes,
    });
    const registered = await catalog.lookup(subject);
    let canary = null;
    let journalReason = null;
    if (payloadMatches) {
      try { canary = await inspectionCanary(journal).inspect(requestFor(config, subject, payload)); }
      catch (error) { journalReason = error.message; }
    }
    const reasons = [];
    if (!payloadMatches) reasons.push('current guest payload generation does not match construction authority');
    const preflightRequired = canary == null || ['absent', 'planned', 'prepared'].includes(canary.phase);
    if (preflightRequired && !preflightResult.ready) reasons.push(preflightResult.reason);
    if (journalReason) reasons.push(journalReason);
    if (canary?.blocked) reasons.push(canary.reason);
    const complete = canary?.complete === true;
    const blocked = !complete && reasons.filter(Boolean).length > 0;
    return publicResult(subject, canary, {
      state: complete ? 'completed' : blocked ? 'blocked' : canary?.phase ?? 'absent',
      reason: blocked ? [...new Set(reasons.filter(Boolean))].join('; ') : null,
      preflight: preflightResult,
      authorityRegistered: registered != null,
    });
  };

  const run = async () => {
    const before = await status();
    if (before.complete) {
      return withRunLock(paths.runLock, async () => {
        const cleanupReason = await cleanupCompletedState({ paths, subject, invoke });
        return publicResult(subject, before, {
          state: 'completed',
          reason: cleanupReason ?? before.reason,
          preflight: before.preflight,
          authorityRegistered: before.authorityRegistered,
        });
      });
    }
    if (before.blocked) return before;
    if (platform !== 'win32') return publicResult(subject, null, { state: 'blocked', reason: 'physical production image canary requires a Windows Hyper-V host', preflight: before.preflight, authorityRegistered: before.authorityRegistered });
    return withRunLock(paths.runLock, async () => {
      const payload = await payloadFactory();
      const request = requestFor(config, subject, payload);
      const registration = await catalog.register(config.authority);
      if (registration.subjectRef !== subject) throw new Error('registered construction authority identity changed');
      const runtime = runtimeFactory
        ? await runtimeFactory({ config, subject, payload, request, paths, catalog, preparationStore, invoke, fetchImpl, signatureVerifierExecutable })
        : await createPhysicalRuntime({ config, subject, payload, paths, invoke, fetchImpl, catalog, preparationStore, signatureVerifierExecutable });
      if (!runtime?.canary || !runtime?.construction || !runtime?.accessProbe || typeof runtime.access !== 'function') throw new TypeError('physical canary runtime contract is incomplete');

      for (let index = 0; index < MAX_ADVANCES; index += 1) {
        const current = await runtime.canary.inspect(request);
        if (current.complete) {
          const cleanupReasons = [];
          if (runtime.addressOwner?.releaseAddress) {
            try { await runtime.addressOwner.releaseAddress(subject); }
            catch (error) { cleanupReasons.push(`network reservation cleanup failed: ${error.message}`); }
          }
          if (runtime.accessMaterial?.discard) {
            try { await runtime.accessMaterial.discard(subject); }
            catch (error) { cleanupReasons.push(`SSH access cleanup failed: ${error.message}`); }
          }
          return publicResult(subject, current, {
            state: 'completed',
            reason: cleanupReasons.length === 0 ? null : cleanupReasons.join('; '),
            authorityRegistered: true,
            preflight: before.preflight,
          });
        }
        if (current.blocked) return publicResult(subject, current, { state: 'blocked', reason: current.reason, authorityRegistered: true, preflight: before.preflight });

        if (current.phase === 'running') {
          const observed = await runtime.construction.status(subject);
          if (observed.state === 'running' && observed.mediaCount > 0) {
            return publicResult(subject, current, { state: 'waiting', reason: 'unattended installer is still running', authorityRegistered: true, preflight: before.preflight });
          }
          if (observed.state !== 'off' && !(observed.state === 'running' && observed.mediaCount === 0)) {
            return publicResult(subject, current, { state: 'waiting', reason: `installer lifecycle is not yet reconcilable: ${observed.state}`, authorityRegistered: true, preflight: before.preflight });
          }
        }

        if (current.phase === 'active') {
          const observed = await runtime.construction.status(subject);
          if (observed.state !== 'running' || observed.mediaCount !== 0) {
            return publicResult(subject, current, { state: 'waiting', reason: 'installed image is not yet running from its retained disk', authorityRegistered: true, preflight: before.preflight });
          }
          const access = await runtime.access(subject);
          const observedAccess = await runtime.accessProbe.inspect(access);
          if (observedAccess.ready !== true) return publicResult(subject, current, { state: 'waiting', reason: `installed image access is not ready: ${observedAccess.reason ?? 'unknown failure'}`, authorityRegistered: true, preflight: before.preflight });
        }

        if (current.phase === 'finalized') {
          const observed = await runtime.construction.status(subject);
          if (observed.state !== 'off') return publicResult(subject, current, { state: 'waiting', reason: 'sanitized image has not finished powering off', authorityRegistered: true, preflight: before.preflight });
        }

        const advanced = await runtime.canary.advance(request);
        if (advanced.blocked) return publicResult(subject, advanced, { state: 'blocked', reason: advanced.reason, authorityRegistered: true, preflight: before.preflight });
      }
      const current = await runtime.canary.inspect(request);
      return publicResult(subject, current, { state: 'waiting', reason: 'bounded canary advancement limit reached; re-run to continue from durable state', authorityRegistered: true, preflight: before.preflight });
    });
  };

  return Object.freeze({ subject, status, run });
}

export { CONFIG_PROTOCOL as UBUNTU_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL };
