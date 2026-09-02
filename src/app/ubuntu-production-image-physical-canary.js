import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createGuestImagePayload } from '../guest/image-payload.js';
import { createCanonicalImageCanary } from '../runtime/image-builders/canonical-image-canary.js';
import { createUbuntuAutoinstallMediaPreparer } from '../runtime/image-builders/ubuntu-autoinstall-media.js';
import { createUbuntuConstructionAuthorityCatalog } from '../runtime/image-builders/ubuntu-construction-authority-catalog.js';
import {
  normalizeUbuntuConstructionAuthority,
  ubuntuConstructionAuthoritySubject,
} from '../runtime/image-builders/ubuntu-construction-authority.js';
import { createProductionImageCanaryComposition } from '../runtime/image-builders/production-image-canary-composition.js';
import { createUbuntuProductionImageQualification } from '../runtime/image-builders/ubuntu-production-qualification.js';
import { createUbuntuProductionSeedFactory } from '../runtime/image-builders/ubuntu-production-seed.js';
import { createUbuntuReleaseMediaSource } from '../runtime/image-sources/ubuntu-release-media.js';
import { observeBoundedReadiness } from '../runtime/bounded-readiness-window.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { createDetachedSignatureVerifier } from '../runtime/detached-signature-verifier.js';
import { createHttpsFileDownload } from '../runtime/https-file-download.js';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';
import { HyperVEnvironmentBootstrap } from '../runtime/providers/hyperv-environment-bootstrap.js';
import { HyperVEnvironmentBridge } from '../runtime/providers/hyperv-environment-bridge.js';
import { createHyperVImageConstruction } from '../runtime/providers/hyperv-image-construction.js';
import { createWindowsImapiNoCloudSeedWriter } from '../runtime/providers/windows-imapi-nocloud-seed.js';
import { createWindowsManagedConstructionNetwork } from '../runtime/providers/windows-managed-construction-network.js';
import { createWindowsProductionImageCanaryPreflight } from '../runtime/providers/windows-production-image-canary-preflight.js';
import { createSshAccessMaterial } from '../runtime/ssh-access-material.js';
import { createSshAccessProbe } from '../runtime/ssh-access-probe.js';
import { createSshImageFinalization } from '../runtime/ssh-image-finalization.js';
import { JsonStateStore } from '../state/json-state-store.js';
import { createCanonicalImageCanaryStateStore } from '../state/canonical-image-canary-state-store.js';
import { createUbuntuConstructionAuthorityStateStore } from '../state/ubuntu-construction-authority-state-store.js';
import { createSubjectPreparationAdapter } from './subject-preparation-adapter.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createCompletionReconciliation } from './ubuntu-production-image-physical-canary/completion-reconciliation.js';
import { createConfigurationContract } from './ubuntu-production-image-physical-canary/configuration-contract.js';
import { createMutationLease } from './ubuntu-production-image-physical-canary/mutation-lease.js';
import { createPreparationContract } from './ubuntu-production-image-physical-canary/preparation-contract.js';
import { createProgressCoordinator } from './ubuntu-production-image-physical-canary/progress-coordinator.js';

const CONFIG_PROTOCOL = 'devbridge/ubuntu-production-image-physical-canary-config-v1';
const STATUS_PROTOCOL = 'devbridge/ubuntu-production-image-physical-canary-status-v1';
const PREPARATION_PROTOCOL = 'devbridge/ubuntu-production-image-physical-preparation-v2';
const MUTATION_LEASE_PROTOCOL = 'devbridge/local-mutation-lease-v1';
const SOURCE_HOSTS = Object.freeze(['releases.ubuntu.com', 'cdimage.ubuntu.com']);
const SHA256 = /^[a-f0-9]{64}$/u;
const SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const MIN_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MIN_DISK_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DISK_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
const MAX_PROCESSORS = 256;
const MAX_ACCESS_SEED_BYTES = 128 * 1024;
const MAX_ADVANCES = 16;
const ACCESS_EXPECTED_MILLISECONDS = 2 * 60 * 1000;
const ACCESS_DEADLINE_MILLISECONDS = 10 * 60 * 1000;
const ACCESS_RECHECK_MILLISECONDS = 30 * 1000;

const configurationContract = createConfigurationContract({
  protocol: CONFIG_PROTOCOL,
  selectionField: 'authority',
  normalizeSelection: normalizeUbuntuConstructionAuthority,
  limits: Object.freeze({
    minimumMemoryBytes: MIN_MEMORY_BYTES,
    maximumMemoryBytes: MAX_MEMORY_BYTES,
    minimumDiskBytes: MIN_DISK_BYTES,
    maximumDiskBytes: MAX_DISK_BYTES,
    maximumProcessors: MAX_PROCESSORS,
  }),
  layout: Object.freeze({
    root: 'production-image-canary',
    lease: 'run.lock',
    selection: 'authority.json',
    progress: 'journal.json',
    preparation: 'preparation.json',
    sourceRoot: 'source',
    cache: 'release-cache',
    source: 'release',
    prepared: 'prepared',
    operation: 'construction',
    output: 'output',
    access: 'access',
    foundation: 'environment-foundation',
  }),
});
const preparationContract = createPreparationContract({
  protocol: PREPARATION_PROTOCOL,
  seedProtocol: 'devbridge/linux-access-seed-v1',
  accessFamily: 'linux',
  sha256Pattern: SHA256,
  snapshotPattern: SNAPSHOT,
  maximumSeedBytes: MAX_ACCESS_SEED_BYTES,
  messages: Object.freeze({
    identityFile: 'physical preparation SSH identity',
    identityChanged: 'physical preparation SSH identity changed',
  }),
});
const mutationLease = createMutationLease({
  protocol: MUTATION_LEASE_PROTOCOL,
  conflictMessage: 'physical canary mutation is already active; remove run.lock only after confirming no operation is running',
});
const completionReconciliation = createCompletionReconciliation();

function pathsFor(config, identity) {
  const selected = configurationContract.derivePaths(config, identity);
  return Object.freeze({
    root: selected.root,
    runLock: selected.lease,
    authorityFile: selected.selection,
    journalFile: selected.progress,
    preparationFile: selected.preparation,
    sourceRoot: selected.sourceRoot,
    subjectRoot: selected.subjectRoot,
    releaseCacheDirectory: selected.cache,
    releaseDirectory: selected.source,
    preparedDirectory: selected.prepared,
    constructionDirectory: selected.operation,
    outputRoot: selected.output,
    accessRoot: selected.access,
    foundationRoot: selected.foundation,
  });
}

function neutralPayload(payload) {
  return Object.freeze({ generation: payload.generation, files: Object.freeze(payload.files.map((file) => Object.freeze({ ...file }))) });
}

function requestFor(config, subject, payload) {
  if (payload.generation !== config.authority.payload.generation) throw new Error('current guest payload generation does not match construction authority');
  const services = config.authority.qualification.services;
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
      ...(services === undefined ? {} : { services: Object.freeze([...services]) }),
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

function publicResult(subject, canary, { state = null, reason = null, preflight = null, authorityRegistered = null, liveness = null, readiness = null, diagnostics = null } = {}) {
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
    liveness,
    readiness,
    diagnostics,
    authorityRegistered,
    preflight,
  });
}

async function cleanupCompletedState({ paths, subject, invoke }) {
  const addressOwner = new HyperVEnvironmentBootstrap({
    directory: path.join(paths.foundationRoot, 'bootstrap', 'attachment'),
    invoke,
    locate: async () => { throw new Error('completed cleanup must not locate a provider subject'); },
    connection: async () => { throw new Error('completed cleanup must not resolve guest access'); },
  });
  const accessMaterial = createSshAccessMaterial({ directory: paths.accessRoot, invoke });
  return completionReconciliation.run([
    Object.freeze({ perform: () => addressOwner.releaseAddress(subject), failure: 'network reservation cleanup failed' }),
    Object.freeze({ perform: () => accessMaterial.discard(subject), failure: 'SSH access cleanup failed' }),
  ]);
}

async function createPhysicalRuntime({ config, subject, payload, paths, invoke, fetchImpl, catalog, preparationStore, signatureVerifierExecutable }) {
  const localIdentity = await loadOrCreateLocalIdentity({ directory: paths.foundationRoot });
  const foundation = await createEnvironmentFoundation({ stateDirectory: config.stateDirectory, platform: 'win32', invoke });
  const constructionNetwork = createWindowsManagedConstructionNetwork({ invoke });
  const construction = createHyperVImageConstruction({
    directory: paths.constructionDirectory,
    sourceRoot: paths.sourceRoot,
    outputRoot: paths.outputRoot,
    identity: localIdentity,
    invoke,
  });
  const accessMaterial = createSshAccessMaterial({ directory: paths.accessRoot, invoke });

  const preparationRequest = (receipt) => Object.freeze({
    identity: subject,
    installer: receipt.installer,
    seed: receipt.seed,
    memoryBytes: config.resources.memoryBytes,
    processorCount: config.resources.processorCount,
    diskBytes: config.resources.diskBytes,
    network: Object.freeze({ control: receipt.network.control, reference: receipt.network.reference, proof: receipt.network.proof }),
  });

  const loadReceipt = async () => {
    const raw = await preparationStore.get(subject);
    if (raw == null) return null;
    const receipt = preparationContract.normalize(raw, Object.freeze({
      identity: subject,
      payloadGeneration: config.authority.payload.generation,
      packageGeneration: config.authority.packages.generation,
      packageSnapshot: config.authority.packages.snapshot,
      resources: config.resources,
    }));
    return preparationContract.verify(receipt);
  };

  const ensureNetworkReceipt = async (receipt) => {
    await foundation.ensureStorage();
    const selected = await constructionNetwork.require();
    if (
      receipt.network.control !== selected.binding.control
      || receipt.network.reference !== selected.binding.reference
      || receipt.network.proof !== selected.binding.proof
      || receipt.network.addressing !== selected.addressing.method
    ) throw new Error('physical preparation network identity changed');
    return receipt;
  };

  const freshReceipt = async (authority) => {
    const observed = await construction.status(subject);
    if (observed.phase !== 'absent') throw new Error('construction state exists without its physical preparation receipt');
    await rm(paths.subjectRoot, { recursive: true, force: true });
    await mkdir(paths.subjectRoot, { recursive: false, mode: 0o700 });
    let preparedAccess = null;
    let selectedNetwork = null;
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
        services: authority.qualification.services ?? [],
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
          selectedNetwork = await constructionNetwork.require();
          preparedAccess = await accessMaterial.prepare(subject);
          const keyMaterial = await preparationContract.readSeed(preparedAccess.seedFile, subject);
          return seedFactory.create({
            identity: subject,
            network: selectedNetwork.addressing,
            authorizedKey: keyMaterial.authorizedKey,
            hostPrivateKey: keyMaterial.hostPrivateKey,
            hostPublicKey: keyMaterial.hostPublicKey,
          });
        },
        seedWriter: createWindowsImapiNoCloudSeedWriter({ invoke }),
      });
      const admitted = await source.acquire({ authorityRef: subject, destination: paths.releaseDirectory });
      const prepared = await media.prepare({ source: admitted, recipeRef: subject, destination: paths.preparedDirectory });
      if (!selectedNetwork || !preparedAccess) throw new Error('physical preparation did not establish bounded host material');
      if (
        prepared.evidence?.seed?.payloadGeneration !== payload.generation
        || prepared.evidence?.seed?.packageGeneration !== authority.packages.generation
        || prepared.evidence?.seed?.packageSnapshot !== authority.packages.snapshot
        || JSON.stringify(prepared.evidence?.seed?.services) !== JSON.stringify(authority.qualification.services ?? [])
        || prepared.evidence?.seed?.networkMethod !== selectedNetwork.addressing.method
      ) throw new Error('prepared seed evidence does not match construction authority');
      await rm(paths.releaseDirectory, { recursive: true, force: true });
      const baseAccess = preparedAccess.connection;
      const [identityEvidence, knownHostsEvidence] = await Promise.all([
        preparationContract.measureRegularFile(baseAccess.identityFile, null, 'physical preparation SSH identity'),
        preparationContract.measureRegularFile(baseAccess.knownHostsFile, null, 'physical preparation known-hosts'),
      ]);
      const receipt = Object.freeze({
        protocol: PREPARATION_PROTOCOL,
        identity: subject,
        payloadGeneration: payload.generation,
        packageGeneration: authority.packages.generation,
        packageSnapshot: authority.packages.snapshot,
        resources: config.resources,
        network: Object.freeze({
          control: selectedNetwork.binding.control,
          reference: selectedNetwork.binding.reference,
          proof: selectedNetwork.binding.proof,
          addressing: selectedNetwork.addressing.method,
        }),
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
    const endpoint = await construction.connectionAddress(target);
    if (endpoint?.ready !== true) throw new Error(endpoint?.reason ?? 'physical canary guest address is unavailable');
    return Object.freeze({ family: 'linux', user: receipt.access.user, address: endpoint.address, identityFile: receipt.access.identityFile, knownHostsFile: receipt.access.knownHostsFile });
  };
  const bridge = new HyperVEnvironmentBridge({ invoke, access, locate: (target) => construction.locate(target) });
  const finalizer = createSshImageFinalization({ invoke, access });
  const qualification = createUbuntuProductionImageQualification({ bridge, finalizer });
  const journal = createCanonicalImageCanaryStateStore(paths.journalFile);
  const canary = createProductionImageCanaryComposition({ journal, preparation, construction, qualification, foundation });
  return Object.freeze({
    canary,
    construction,
    access,
    accessProbe: createSshAccessProbe({ invoke }),
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
  now = () => new Date(),
} = {}) {
  const selectedConfig = configurationContract.normalize(rawConfig);
  const config = Object.freeze({
    protocol: selectedConfig.protocol,
    stateDirectory: selectedConfig.stateDirectory,
    keyring: selectedConfig.keyring,
    authority: selectedConfig.selection,
    resources: selectedConfig.resources,
  });
  if (typeof invoke !== 'function') throw new TypeError('physical canary invocation contract is invalid');
  if (typeof payloadFactory !== 'function') throw new TypeError('physical canary payload factory is invalid');
  if (runtimeFactory != null && typeof runtimeFactory !== 'function') throw new TypeError('physical canary runtime factory is invalid');
  if (typeof now !== 'function') throw new TypeError('physical canary clock must be a function');
  if (signatureVerifierExecutable != null && (typeof signatureVerifierExecutable !== 'string' || signatureVerifierExecutable.length === 0 || signatureVerifierExecutable.includes('\0') || !path.win32.isAbsolute(signatureVerifierExecutable))) throw new TypeError('physical canary signature-verifier binding is invalid');
  const subject = ubuntuConstructionAuthoritySubject(config.authority);
  const paths = pathsFor(config, subject);
  const authorityStore = createUbuntuConstructionAuthorityStateStore(paths.authorityFile);
  const catalog = createUbuntuConstructionAuthorityCatalog({ store: authorityStore });
  const journal = createCanonicalImageCanaryStateStore(paths.journalFile);
  const preparationStore = new JsonStateStore(paths.preparationFile);
  const selectedPreflight = preflight ?? createWindowsProductionImageCanaryPreflight({ invoke, platform, signatureVerifierExecutable });
  if (!selectedPreflight || typeof selectedPreflight.inspect !== 'function') throw new TypeError('physical canary preflight contract is incomplete');
  const progress = createProgressCoordinator({
    maximumAdvances: MAX_ADVANCES,
    measureReadiness: (elapsedMilliseconds) => observeBoundedReadiness({
      elapsedMilliseconds,
      observedAt: now(),
      expectedMilliseconds: ACCESS_EXPECTED_MILLISECONDS,
      deadlineMilliseconds: ACCESS_DEADLINE_MILLISECONDS,
      recheckMilliseconds: ACCESS_RECHECK_MILLISECONDS,
    }),
    messages: Object.freeze({
      evidenceUnavailable: 'Hyper-V console evidence adapter is unavailable',
      progressBlocked: (classification) => `installer liveness is ${classification}; no automatic VM repair was attempted`,
      progressing: 'installer VHDX allocation advanced since the previous bounded observation',
      slow: 'installer exceeded its expected completion window but remains within its hard deadline',
      progressPending: 'installer VM is powered on; bounded progress evidence is pending',
      progressUnavailable: 'installer VM is powered on, but bounded liveness evidence is unavailable',
      lifecyclePending: (state) => `installer lifecycle is not yet reconcilable: ${state}`,
      outputNotReady: 'installed image is not yet running from its retained disk',
      endpointNotReady: (reason) => `installed image access endpoint is not ready: ${reason}`,
      endpointUnready: (reason) => `installed image access is not ready: ${reason}`,
      readinessExpired: (reason) => `installed image access readiness deadline expired: ${reason}; no automatic repair was attempted`,
      shutdownPending: 'sanitized image has not finished powering off',
      advancementLimit: 'bounded canary advancement limit reached; re-run to continue from durable state',
    }),
  });

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
      return mutationLease.run(paths.runLock, async () => {
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
    return mutationLease.run(paths.runLock, async () => {
      const payload = await payloadFactory();
      const request = requestFor(config, subject, payload);
      const registration = await catalog.register(config.authority);
      if (registration.subjectRef !== subject) throw new Error('registered construction authority identity changed');
      const runtime = runtimeFactory
        ? await runtimeFactory({ config, subject, payload, request, paths, catalog, preparationStore, invoke, fetchImpl, signatureVerifierExecutable })
        : await createPhysicalRuntime({ config, subject, payload, paths, invoke, fetchImpl, catalog, preparationStore, signatureVerifierExecutable });
      if (!runtime?.canary || !runtime?.construction || !runtime?.accessProbe || typeof runtime.access !== 'function') throw new TypeError('physical canary runtime contract is incomplete');

      return progress.run({
        inspect: () => runtime.canary.inspect(request),
        advance: () => runtime.canary.advance(request),
        observeProgress: () => typeof runtime.construction.observeInstall === 'function'
          ? runtime.construction.observeInstall(subject)
          : runtime.construction.status(subject),
        observeLifecycle: () => runtime.construction.status(subject),
        resolveEndpoint: () => runtime.access(subject),
        inspectEndpoint: (endpoint) => runtime.accessProbe.inspect(endpoint),
        captureEvidence: typeof runtime.construction.captureInstallConsole === 'function'
          ? () => runtime.construction.captureInstallConsole(subject)
          : null,
        reconcileCompletion: () => {
          const actions = [];
          if (runtime.addressOwner?.releaseAddress) actions.push(Object.freeze({ perform: () => runtime.addressOwner.releaseAddress(subject), failure: 'network reservation cleanup failed' }));
          if (runtime.accessMaterial?.discard) actions.push(Object.freeze({ perform: () => runtime.accessMaterial.discard(subject), failure: 'SSH access cleanup failed' }));
          return completionReconciliation.run(actions);
        },
        present: (current, details) => publicResult(subject, current, { ...details, authorityRegistered: true, preflight: before.preflight }),
      });
    });
  };

  return Object.freeze({ subject, status, run });
}

export { CONFIG_PROTOCOL as UBUNTU_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL };
