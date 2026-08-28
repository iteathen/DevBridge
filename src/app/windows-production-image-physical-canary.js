import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { createWindowsGuestImagePayload } from '../guest/windows-image-payload.js';
import { createCanonicalImageCanary } from '../runtime/image-builders/canonical-image-canary.js';
import { createProductionImageCanaryComposition } from '../runtime/image-builders/production-image-canary-composition.js';
import { createWindowsProductionImageAuthorityCatalog } from '../runtime/image-builders/windows-production-image-authority-catalog.js';
import {
  normalizeWindowsProductionImageAuthority,
  windowsProductionImageAuthoritySubject,
} from '../runtime/image-builders/windows-production-image-authority.js';
import { createWindowsProductionOperations } from '../runtime/image-builders/windows-production-operations.js';
import { createWindowsProductionQualification } from '../runtime/image-builders/windows-production-qualification.js';
import { createWindowsUnattendedMediaPreparer } from '../runtime/image-builders/windows-unattended-media.js';
import { createWindowsUnattendedSeed } from '../runtime/image-builders/windows-unattended-seed.js';
import { createWindowsInstallMediaInspector } from '../runtime/image-sources/windows-install-media-inspector.js';
import { observeBoundedReadiness } from '../runtime/bounded-readiness-window.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';
import { createHyperVGuestOperation } from '../runtime/providers/hyperv-guest-operation.js';
import { createHyperVImageConstruction } from '../runtime/providers/hyperv-image-construction.js';
import { createWindowsImapiDataMediaWriter } from '../runtime/providers/windows-imapi-data-media.js';
import { createWindowsManagedConstructionNetwork } from '../runtime/providers/windows-managed-construction-network.js';
import { createWindowsProtectedAccessMaterial } from '../runtime/providers/windows-protected-access-material.js';
import { createWindowsProtectedImageConstructionPreflight } from '../runtime/providers/windows-protected-image-construction-preflight.js';
import { createCanonicalImageCanaryStateStore } from '../state/canonical-image-canary-state-store.js';
import { JsonStateStore } from '../state/json-state-store.js';
import { createWindowsProductionImageAuthorityStateStore } from '../state/windows-production-image-authority-state-store.js';
import { createWindowsProductionQualificationStateStore } from '../state/windows-production-qualification-state-store.js';
import { requiredBootProtection } from '../values/boot-protection.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createSubjectPreparationAdapter } from './subject-preparation-adapter.js';

export const WINDOWS_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL = 'devbridge/windows-production-image-physical-canary-config-v1';
export const WINDOWS_PRODUCTION_IMAGE_PHYSICAL_CANARY_STATUS_PROTOCOL = 'devbridge/windows-production-image-physical-canary-status-v1';

const PREPARATION_PROTOCOL = 'devbridge/windows-production-image-physical-preparation-v1';
const MIN_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MIN_DISK_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_DISK_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
const MIN_ALLOCATION_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_PROCESSORS = 256;
const MAX_ADVANCES = 16;
const ACCESS_EXPECTED_MILLISECONDS = 2 * 60 * 1000;
const ACCESS_DEADLINE_MILLISECONDS = 15 * 60 * 1000;
const ACCESS_RECHECK_MILLISECONDS = 30 * 1000;

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
  const value = onlyKeys(raw, new Set(['protocol', 'stateDirectory', 'sourceLocation', 'authority', 'resources']), 'physical canary config');
  if (value.protocol !== WINDOWS_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL) throw new TypeError('physical canary config protocol is unsupported');
  const resources = onlyKeys(value.resources, new Set(['memoryBytes', 'processorCount', 'diskBytes', 'allocationBytes']), 'physical canary resources');
  const diskBytes = boundedInteger(resources.diskBytes, MIN_DISK_BYTES, MAX_DISK_BYTES, 'physical canary resources.diskBytes');
  const allocationBytes = boundedInteger(resources.allocationBytes, MIN_ALLOCATION_BYTES, diskBytes, 'physical canary resources.allocationBytes');
  return Object.freeze({
    protocol: value.protocol,
    stateDirectory: absolutePath(value.stateDirectory, 'physical canary stateDirectory'),
    sourceLocation: absolutePath(value.sourceLocation, 'physical canary sourceLocation'),
    authority: normalizeWindowsProductionImageAuthority(value.authority),
    resources: Object.freeze({
      memoryBytes: boundedInteger(resources.memoryBytes, MIN_MEMORY_BYTES, MAX_MEMORY_BYTES, 'physical canary resources.memoryBytes'),
      processorCount: boundedInteger(resources.processorCount, 2, MAX_PROCESSORS, 'physical canary resources.processorCount'),
      diskBytes,
      allocationBytes,
    }),
  });
}

function pathsFor(config, subject) {
  const root = path.join(config.stateDirectory, 'windows-production-image-canary');
  const subjectRoot = path.join(root, 'subjects', subject);
  return Object.freeze({
    root,
    runLock: path.join(root, 'run.lock'),
    authorityFile: path.join(root, 'authority.json'),
    journalFile: path.join(root, 'journal.json'),
    preparationFile: path.join(root, 'preparation.json'),
    qualificationFile: path.join(root, 'qualification.json'),
    constructionDirectory: path.join(root, 'construction'),
    outputRoot: path.join(root, 'output'),
    subjectRoot,
    preparedDirectory: path.join(subjectRoot, 'prepared'),
    accessRoot: path.join(root, 'access'),
    foundationRoot: path.join(config.stateDirectory, 'environment-foundation'),
  });
}

function receiptMedia(raw, name) {
  const value = onlyKeys(raw, new Set(['location', 'bytes', 'sha256']), name);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new TypeError(`${name} identity is invalid`);
  return Object.freeze({ location: absolutePath(value.location, `${name}.location`), bytes: value.bytes, sha256: value.sha256 });
}

function normalizePreparation(raw, config, subject) {
  const value = onlyKeys(raw, new Set(['protocol', 'identity', 'resources', 'network', 'installer', 'seed', 'accessUser']), 'physical preparation');
  if (value.protocol !== PREPARATION_PROTOCOL || value.identity !== subject || value.accessUser !== 'Administrator') throw new Error('physical preparation identity changed');
  const resources = onlyKeys(value.resources, new Set(['memoryBytes', 'processorCount', 'diskBytes', 'allocationBytes']), 'physical preparation resources');
  if (JSON.stringify(resources) !== JSON.stringify(config.resources)) throw new Error('physical preparation resource policy changed');
  const network = onlyKeys(value.network, new Set(['control', 'reference', 'proof', 'addressing']), 'physical preparation network');
  if (!['owned', 'system'].includes(network.control) || network.addressing !== 'automatic') throw new Error('physical preparation network is invalid');
  return Object.freeze({
    protocol: value.protocol,
    identity: subject,
    resources: config.resources,
    network: Object.freeze({ ...network }),
    installer: receiptMedia(value.installer, 'physical preparation installer'),
    seed: receiptMedia(value.seed, 'physical preparation seed'),
    accessUser: value.accessUser,
  });
}

async function exactReceiptFile(receipt, name) {
  const info = await lstat(receipt.location);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== receipt.bytes) throw new Error(`${name} changed after preparation`);
}

function requestFor(config, subject, payload) {
  if (payload.generation !== config.authority.payload.generation) throw new Error('current guest payload generation does not match production image authority');
  const node = config.authority.tools.artifacts.find(({ identity }) => identity === 'node');
  const sourceControl = config.authority.tools.artifacts.find(({ identity }) => identity === 'source-control');
  const nativeBuild = config.authority.tools.artifacts.find(({ identity }) => identity === 'build-tools');
  if (!node || !sourceControl || !nativeBuild) throw new Error('production image tool authority is incomplete');
  return Object.freeze({
    identity: subject,
    work: Object.freeze({ subject }),
    check: Object.freeze({
      build: config.authority.media.image.build,
      edition: config.authority.media.image.edition,
      architecture: config.authority.media.image.architecture,
      installationType: config.authority.media.image.installationType,
      defaultLanguage: config.authority.media.image.defaultLanguage,
      authorityGeneration: config.authority.tools.generation,
      payloadGeneration: payload.generation,
      nodeVersion: node.version,
      sourceControlVersion: sourceControl.version,
      nativeBuildVersion: nativeBuild.installedVersion,
    }),
    output: Object.freeze({
      profile: config.authority.output.profile,
      generation: config.authority.output.generation,
      provenance: Object.freeze({
        origin: 'windows-production-image-canary',
        authority: subject,
        source: config.authority.media.media.sha256,
        tools: config.authority.tools.generation,
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

function publicResult(subject, canary, { state = null, reason = null, preflight = null, authorityRegistered = null, readiness = null, liveness = null, diagnostics = null } = {}) {
  const selectedState = state ?? (canary?.complete ? 'completed' : canary?.blocked ? 'blocked' : canary?.phase ?? 'unavailable');
  return Object.freeze({
    protocol: WINDOWS_PRODUCTION_IMAGE_PHYSICAL_CANARY_STATUS_PROTOCOL,
    subject,
    state: selectedState,
    phase: canary?.phase ?? null,
    complete: canary?.complete === true,
    blocked: selectedState === 'blocked',
    reason: reason ?? canary?.reason ?? null,
    image: canary?.image ?? null,
    readiness,
    liveness,
    diagnostics,
    authorityRegistered,
    preflight,
  });
}

async function withRunLock(location, work) {
  await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(location, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error('physical canary mutation is already active; reconcile the exact owner before removing its lock');
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    await handle.sync();
    return await work();
  } finally {
    await handle.close().catch(() => {});
    await rm(location, { force: true }).catch(() => {});
  }
}

async function sourceAvailability(config) {
  try {
    const info = await lstat(config.sourceLocation);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== config.authority.media.media.bytes || path.basename(config.sourceLocation) !== config.authority.media.media.name) {
      return Object.freeze({ ready: false, reason: 'approved source media file identity is unavailable' });
    }
    return Object.freeze({ ready: true, reason: null });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ ready: false, reason: 'approved source media file is unavailable' });
    return Object.freeze({ ready: false, reason: 'approved source media file could not be observed' });
  }
}

async function createPhysicalRuntime({ config, subject, payload, paths, invoke, catalog, preparationStore }) {
  const localIdentity = await loadOrCreateLocalIdentity({ directory: paths.foundationRoot });
  const foundation = await createEnvironmentFoundation({ stateDirectory: config.stateDirectory, platform: 'win32', invoke });
  const network = createWindowsManagedConstructionNetwork({ invoke });
  const construction = createHyperVImageConstruction({
    directory: paths.constructionDirectory,
    sourceRoot: paths.subjectRoot,
    outputRoot: paths.outputRoot,
    identity: localIdentity,
    invoke,
  });
  const accessMaterial = createWindowsProtectedAccessMaterial({ directory: paths.accessRoot, invoke });

  const loadReceipt = async () => {
    const raw = await preparationStore.get(subject);
    if (raw == null) return null;
    const receipt = normalizePreparation(raw, config, subject);
    await exactReceiptFile(receipt.installer, 'physical preparation installer');
    await exactReceiptFile(receipt.seed, 'physical preparation seed');
    await accessMaterial.resolve(subject);
    return receipt;
  };

  const freshReceipt = async (authority) => {
    const observed = await construction.status(subject);
    if (observed.phase !== 'absent') throw new Error('construction state exists without its physical preparation receipt');
    await rm(paths.subjectRoot, { recursive: true, force: true });
    await mkdir(paths.subjectRoot, { recursive: false, mode: 0o700 });
    try {
      const sourceDirectory = path.join(paths.subjectRoot, 'source');
      await mkdir(sourceDirectory, { recursive: false, mode: 0o700 });
      const admittedSource = path.join(sourceDirectory, config.authority.media.media.name);
      await copyFile(config.sourceLocation, admittedSource, fsConstants.COPYFILE_EXCL);
      const sourceInfo = await lstat(admittedSource);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== config.authority.media.media.bytes) throw new Error('imported source media identity changed');
      await accessMaterial.ensure(subject);
      const access = await accessMaterial.resolve(subject);
      const selectedNetwork = await network.require();
      const media = createWindowsUnattendedMediaPreparer({
        admission: {
          async lookup(reference) {
            if (reference !== subject) throw new Error('physical preparation authority subject changed');
            return authority.media;
          },
        },
        observer: createWindowsInstallMediaInspector({ sourceRoot: sourceDirectory, invoke }),
        seedFactory: createWindowsUnattendedSeed,
        mediaWriter: createWindowsImapiDataMediaWriter({ invoke }),
      });
      const prepared = await media.prepare({ subject, source: admittedSource, destination: paths.preparedDirectory, access });
      if (prepared.evidence?.seed?.generation !== authority.recipe.generation) throw new Error('prepared recipe generation changed');
      const receipt = Object.freeze({
        protocol: PREPARATION_PROTOCOL,
        identity: subject,
        resources: config.resources,
        network: Object.freeze({
          control: selectedNetwork.binding.control,
          reference: selectedNetwork.binding.reference,
          proof: selectedNetwork.binding.proof,
          addressing: selectedNetwork.addressing.method,
        }),
        installer: Object.freeze({ ...prepared.installer }),
        seed: Object.freeze({ location: prepared.seed.location, bytes: prepared.seed.bytes, sha256: prepared.seed.sha256 }),
        accessUser: access.user,
      });
      await preparationStore.set(subject, receipt);
      return receipt;
    } catch (error) {
      await accessMaterial.discard(subject).catch(() => {});
      await rm(paths.subjectRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  };

  const preparation = createSubjectPreparationAdapter({
    async resolve(reference) {
      if (reference !== subject) throw new Error('physical preparation subject changed');
      const authority = await catalog.lookup(reference);
      if (!authority) throw new Error('production image authority is unavailable');
      const receipt = await loadReceipt() ?? await freshReceipt(authority);
      const selectedNetwork = await network.require();
      if (
        receipt.network.control !== selectedNetwork.binding.control
        || receipt.network.reference !== selectedNetwork.binding.reference
        || receipt.network.proof !== selectedNetwork.binding.proof
        || receipt.network.addressing !== selectedNetwork.addressing.method
      ) throw new Error('physical preparation network identity changed');
      return Object.freeze({
        identity: subject,
        installer: receipt.installer,
        seed: receipt.seed,
        memoryBytes: config.resources.memoryBytes,
        processorCount: config.resources.processorCount,
        diskBytes: config.resources.diskBytes,
        network: Object.freeze({ control: receipt.network.control, reference: receipt.network.reference, proof: receipt.network.proof }),
        bootProtection: requiredBootProtection(),
      });
    },
    apply: (request) => construction.prepare(request),
  });

  const operations = createHyperVGuestOperation({
    invoke,
    locate: (target) => construction.locate(target),
    access: (target) => accessMaterial.resolve(target),
    operations: createWindowsProductionOperations({ authority: config.authority.tools, payload }),
  });
  const qualification = createWindowsProductionQualification({
    journal: createWindowsProductionQualificationStateStore(paths.qualificationFile),
    operations,
    observe: (target) => construction.status(target),
  });
  const canary = createProductionImageCanaryComposition({
    journal: createCanonicalImageCanaryStateStore(paths.journalFile),
    preparation,
    construction,
    qualification,
    foundation,
  });
  return Object.freeze({
    canary,
    construction,
    accessMaterial,
    async readiness(target) {
      try {
        const result = await operations.execute({ target, operation: 'status-v1', input: {}, timeoutMs: 30_000 });
        return Object.freeze({ ready: result?.ready === true, reason: result?.ready === true ? null : 'guest preparation marker is unavailable' });
      } catch { return Object.freeze({ ready: false, reason: 'guest operation channel is not ready' }); }
    },
    cleanupTransient: () => rm(paths.subjectRoot, { recursive: true, force: true }),
  });
}

export function createWindowsProductionImagePhysicalCanary(rawConfig, {
  platform = process.platform,
  invoke = invokeCommand,
  payloadFactory = createWindowsGuestImagePayload,
  preflight = null,
  runtimeFactory = null,
  now = () => new Date(),
} = {}) {
  const config = normalizeConfig(rawConfig);
  if (typeof invoke !== 'function' || typeof payloadFactory !== 'function' || typeof now !== 'function') throw new TypeError('physical canary dependency contract is invalid');
  if (runtimeFactory != null && typeof runtimeFactory !== 'function') throw new TypeError('physical canary runtime factory is invalid');
  const subject = windowsProductionImageAuthoritySubject(config.authority);
  const paths = pathsFor(config, subject);
  const catalog = createWindowsProductionImageAuthorityCatalog({ store: createWindowsProductionImageAuthorityStateStore(paths.authorityFile) });
  const journal = createCanonicalImageCanaryStateStore(paths.journalFile);
  const preparationStore = new JsonStateStore(paths.preparationFile);
  const selectedPreflight = preflight ?? createWindowsProtectedImageConstructionPreflight({ invoke, platform });
  if (!selectedPreflight || typeof selectedPreflight.inspect !== 'function') throw new TypeError('physical canary preflight contract is incomplete');

  const status = async () => {
    const payload = await payloadFactory();
    const source = await sourceAvailability(config);
    const preflightResult = await selectedPreflight.inspect({
      stateDirectory: config.stateDirectory,
      memoryBytes: config.resources.memoryBytes,
      diskBytes: config.resources.diskBytes,
      allocationBytes: config.resources.allocationBytes,
      sourceBytes: config.authority.media.media.bytes,
    });
    const registered = await catalog.lookup(subject);
    let canary = null;
    let journalReason = null;
    if (payload?.generation === config.authority.payload.generation) {
      try { canary = await inspectionCanary(journal).inspect(requestFor(config, subject, payload)); }
      catch (error) { journalReason = error.message; }
    }
    const complete = canary?.complete === true;
    const preflightRequired = canary == null || ['absent', 'planned', 'prepared'].includes(canary.phase);
    const reasons = [];
    if (payload?.generation !== config.authority.payload.generation) reasons.push('current guest payload generation does not match production image authority');
    if (preflightRequired && !source.ready) reasons.push(source.reason);
    if (preflightRequired && !preflightResult.ready) reasons.push(preflightResult.reason);
    if (journalReason) reasons.push(journalReason);
    if (canary?.blocked) reasons.push(canary.reason);
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
        const reasons = [];
        try { await createWindowsProtectedAccessMaterial({ directory: paths.accessRoot, invoke }).discard(subject); }
        catch (error) { reasons.push(`temporary access cleanup failed: ${error.message}`); }
        await rm(paths.subjectRoot, { recursive: true, force: true }).catch(() => {});
        return publicResult(subject, before, { state: 'completed', reason: reasons.length === 0 ? null : reasons.join('; '), preflight: before.preflight, authorityRegistered: true });
      });
    }
    if (before.blocked) return before;
    if (platform !== 'win32') return publicResult(subject, null, { state: 'blocked', reason: 'physical production image canary requires a Windows virtualization host', preflight: before.preflight, authorityRegistered: before.authorityRegistered });

    return withRunLock(paths.runLock, async () => {
      const payload = await payloadFactory();
      const request = requestFor(config, subject, payload);
      const registration = await catalog.register(config.authority);
      if (registration.subjectRef !== subject) throw new Error('registered production image authority identity changed');
      const runtime = runtimeFactory
        ? await runtimeFactory({ config, subject, payload, request, paths, catalog, preparationStore, invoke })
        : await createPhysicalRuntime({ config, subject, payload, paths, invoke, catalog, preparationStore });
      if (!runtime?.canary || !runtime?.construction || typeof runtime.readiness !== 'function') throw new TypeError('physical canary runtime contract is incomplete');

      for (let index = 0; index < MAX_ADVANCES; index += 1) {
        const current = await runtime.canary.inspect(request);
        if (current.complete) {
          const reasons = [];
          try { await runtime.cleanupTransient?.(); } catch (error) { reasons.push(`transient media cleanup failed: ${error.message}`); }
          try { await runtime.accessMaterial?.discard(subject); } catch (error) { reasons.push(`temporary access cleanup failed: ${error.message}`); }
          return publicResult(subject, current, { state: 'completed', reason: reasons.length === 0 ? null : reasons.join('; '), authorityRegistered: true, preflight: before.preflight });
        }
        if (current.blocked) return publicResult(subject, current, { state: 'blocked', reason: current.reason, authorityRegistered: true, preflight: before.preflight });

        if (current.phase === 'running') {
          const observed = typeof runtime.construction.observeInstall === 'function'
            ? await runtime.construction.observeInstall(subject)
            : await runtime.construction.status(subject);
          if (observed.state === 'running' && observed.mediaCount > 0) {
            const classification = observed.liveness?.classification ?? null;
            let diagnostics = null;
            if (['slow', 'stalled', 'overdue'].includes(classification) && typeof runtime.construction.captureInstallConsole === 'function') {
              try { diagnostics = await runtime.construction.captureInstallConsole(subject); }
              catch (error) { diagnostics = Object.freeze({ available: false, reason: String(error?.message ?? error).slice(0, 512) }); }
            }
            if (['stalled', 'overdue'].includes(classification)) return publicResult(subject, current, { state: 'blocked', reason: `installer liveness is ${classification}; no automatic repair was attempted`, liveness: observed.liveness ?? null, diagnostics, authorityRegistered: true, preflight: before.preflight });
            return publicResult(subject, current, { state: 'waiting', reason: 'installer is active; bounded progress evidence is pending', liveness: observed.liveness ?? null, diagnostics, authorityRegistered: true, preflight: before.preflight });
          }
          if (observed.state !== 'off' && !(observed.state === 'running' && observed.mediaCount === 0)) return publicResult(subject, current, { state: 'waiting', reason: `installer lifecycle is not yet reconcilable: ${observed.state}`, authorityRegistered: true, preflight: before.preflight });
        }

        if (current.phase === 'active') {
          const observed = await runtime.construction.status(subject);
          if (observed.state !== 'running' || observed.mediaCount !== 0) return publicResult(subject, current, { state: 'waiting', reason: 'installed image is not yet running from its retained disk', authorityRegistered: true, preflight: before.preflight });
          await runtime.cleanupTransient?.();
          const access = await runtime.readiness(subject);
          if (access.ready !== true) {
            const readiness = observeBoundedReadiness({ elapsedMilliseconds: observed.uptimeMilliseconds, observedAt: now(), expectedMilliseconds: ACCESS_EXPECTED_MILLISECONDS, deadlineMilliseconds: ACCESS_DEADLINE_MILLISECONDS, recheckMilliseconds: ACCESS_RECHECK_MILLISECONDS });
            if (readiness.classification === 'expired') return publicResult(subject, current, { state: 'blocked', reason: `installed image access readiness deadline expired: ${access.reason}; no automatic repair was attempted`, readiness, authorityRegistered: true, preflight: before.preflight });
            return publicResult(subject, current, { state: 'waiting', reason: access.reason, readiness, authorityRegistered: true, preflight: before.preflight });
          }
        }

        if (current.phase === 'finalized') {
          const observed = await runtime.construction.status(subject);
          if (observed.state !== 'off') return publicResult(subject, current, { state: 'waiting', reason: 'generalized image has not finished powering off', authorityRegistered: true, preflight: before.preflight });
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
