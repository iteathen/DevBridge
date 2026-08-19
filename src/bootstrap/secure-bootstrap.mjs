import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as transactional from './transactional-bootstrap.mjs';
import { validateRuntimeCandidate as sandboxValidateRuntimeCandidate } from './candidate-validator.mjs';
import {
  readSignedReleaseManifest,
  runtimeArtifactSha256,
  verifyRuntimeReleaseIntegrity,
} from './release-integrity.mjs';
import { runtimeArtifactSha256Sync } from './runtime-artifact-sync.mjs';

export * from './transactional-bootstrap.mjs';

function fail(message) { throw new Error(message); }

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
  return value;
}

function exactDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : null;
}

export function parseBootstrapArgs(argv) {
  const passthrough = [];
  let releaseMode = 'development';
  let releaseManifest = null;
  let releasePublicKey = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--release-mode') {
      releaseMode = takeValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === '--release-manifest') {
      releaseManifest = takeValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === '--release-public-key') {
      releasePublicKey = takeValue(argv, index, value);
      index += 1;
      continue;
    }
    passthrough.push(value);
  }
  if (!['development', 'production'].includes(releaseMode)) fail('release mode must be development or production');
  const base = transactional.parseBootstrapArgs(passthrough);
  if (releaseMode === 'production') {
    if (base.channel !== 'stable') fail('production release mode requires --channel stable');
    if (!releaseManifest || !releasePublicKey) {
      fail('production release mode requires --release-manifest and --release-public-key local paths');
    }
  } else if (releaseManifest || releasePublicKey) {
    fail('release manifest/public-key paths are valid only with --release-mode production');
  }
  return {
    ...base,
    releaseMode,
    releaseManifest: releaseManifest ? path.resolve(releaseManifest) : null,
    releasePublicKey: releasePublicKey ? path.resolve(releasePublicKey) : null,
  };
}

export const validateRuntimeCandidate = sandboxValidateRuntimeCandidate;

export async function prepareRuntimeCandidate(args, paths, {
  desiredRef,
  desiredHead,
  runner,
  ensureRuntimeFn = transactional.ensureRuntime,
  validateCandidateFn = sandboxValidateRuntimeCandidate,
  releaseManifest = null,
  env = process.env,
} = {}) {
  if (!desiredRef || !/^[0-9a-f]{40}$/iu.test(String(desiredHead))) {
    fail('candidate preparation requires a trusted ref and exact head');
  }
  const runtimeDir = transactional.candidateRuntimePath(paths, desiredHead);
  const candidatePaths = { ...paths, runtime: runtimeDir };
  const candidate = ensureRuntimeFn({ ...args, update: true }, candidatePaths, runner);
  if (candidate.ref !== desiredRef || candidate.head.toLowerCase() !== String(desiredHead).toLowerCase()) {
    fail(`candidate changed during preparation; expected ${desiredRef}@${desiredHead}, observed ${candidate.ref}@${candidate.head}`);
  }
  const runtime = { ...candidate, runtimeDir };

  // Static release identity is verified before candidate-controlled code runs.
  const releaseIntegrity = await verifyRuntimeReleaseIntegrity({ args, runtime, manifest: releaseManifest });
  const validation = await validateCandidateFn(paths, runtime, runner, {
    expectedArtifactSha256: releaseIntegrity.artifactSha256,
    env,
  });
  if (validation.artifactSha256 !== releaseIntegrity.artifactSha256) {
    fail('candidate tested artifact digest does not match the statically verified release artifact');
  }
  // Re-run the static digest/signature check after candidate tests so the exact
  // bytes accepted for activation are the exact bytes that were tested at the
  // end of validation. superviseDaemon performs one more synchronous digest
  // check immediately before spawning that runtime after the drain window.
  const afterIntegrity = await verifyRuntimeReleaseIntegrity({ args, runtime, manifest: releaseManifest });
  if (afterIntegrity.artifactSha256 !== validation.artifactSha256) {
    fail('candidate artifact changed after sandbox validation');
  }
  return {
    ...runtime,
    artifactSha256: validation.artifactSha256,
    releaseIntegrity: afterIntegrity,
    validation,
  };
}

function augmentRuntimeRecord(record, integrityByHead) {
  if (!record?.head) return record;
  const known = integrityByHead.get(String(record.head).toLowerCase());
  if (!known) return record;
  return {
    ...record,
    artifactSha256: known.artifactSha256,
    releaseIntegrity: known.releaseIntegrity ? {
      mode: known.releaseIntegrity.mode,
      verified: known.releaseIntegrity.verified,
      immutableRelease: known.releaseIntegrity.immutableRelease,
      manifestSha256: known.releaseIntegrity.manifestSha256,
      keyId: known.releaseIntegrity.keyId,
    } : null,
    validationSandbox: known.validation?.sandbox ?? null,
  };
}

function augmentActivationRecord(record, integrityByHead) {
  return {
    ...record,
    previous: augmentRuntimeRecord(record.previous, integrityByHead),
    candidate: augmentRuntimeRecord(record.candidate, integrityByHead),
    current: augmentRuntimeRecord(record.current, integrityByHead),
    failedCandidate: augmentRuntimeRecord(record.failedCandidate, integrityByHead),
  };
}

function acceptedRuntimeForCwd(integrityByHead, cwd) {
  const resolved = path.resolve(cwd);
  for (const runtime of integrityByHead.values()) {
    if (runtime?.runtimeDir && path.resolve(runtime.runtimeDir) === resolved) return runtime;
  }
  return null;
}

export async function superviseDaemon(args, paths, initialRuntime, options = {}) {
  const integrityByHead = new Map();
  if (initialRuntime?.head) integrityByHead.set(initialRuntime.head.toLowerCase(), initialRuntime);
  const manifest = args.releaseMode === 'production'
    ? await readSignedReleaseManifest(args.releaseManifest, args.releasePublicKey)
    : null;
  const baseRemoteHeadFn = options.remoteHeadFn ?? transactional.remoteBranchHead;
  const baseResolveChannelRefFn = options.resolveChannelRefFn ?? transactional.resolveChannelRef;
  const baseRecordActivationFn = options.recordActivationFn ?? transactional.writeRuntimeActivationState;
  const candidatePrepareInjected = typeof options.candidatePrepareFn === 'function';
  const baseCandidatePrepareFn = options.candidatePrepareFn ?? prepareRuntimeCandidate;
  const baseSpawnImpl = options.spawnImpl ?? spawn;
  const artifactDigestSyncFn = options.artifactDigestSyncFn ?? runtimeArtifactSha256Sync;

  const remoteHeadFn = args.releaseMode === 'production'
    ? (ref, context) => {
        const observed = baseRemoteHeadFn(ref, context);
        // The mutable stable branch is transport only. It never becomes the
        // production authority: update discovery yields a candidate only while
        // that transport points at the independently signed immutable subject.
        return observed === manifest.release.head ? manifest.release.head : null;
      }
    : baseRemoteHeadFn;

  const candidatePrepareFn = async (localArgs, localPaths, input) => {
    const candidate = await baseCandidatePrepareFn(localArgs, localPaths, {
      ...input,
      releaseManifest: manifest,
    });
    if (!exactDigest(candidate?.artifactSha256)) {
      // Production never permits this seam. In development it exists only for
      // local programmatic supervisor test fixtures that inject their own
      // candidatePrepareFn; the real/default preparation path above always
      // returns an exact digest after verified sandbox validation.
      if (args.releaseMode === 'production' || !candidatePrepareInjected) {
        fail('candidate preparation did not return an exact tested runtime artifact digest');
      }
      integrityByHead.set(candidate.head.toLowerCase(), candidate);
      return candidate;
    }
    integrityByHead.set(candidate.head.toLowerCase(), candidate);
    return candidate;
  };

  const recordActivationFn = async (localPaths, record) => baseRecordActivationFn(
    localPaths,
    augmentActivationRecord(record, integrityByHead),
  );

  const spawnImpl = (executable, argv, spawnOptions = {}) => {
    const accepted = acceptedRuntimeForCwd(integrityByHead, spawnOptions.cwd ?? '.');
    if (accepted?.artifactSha256) {
      const observed = artifactDigestSyncFn(accepted.runtimeDir);
      if (observed.sha256 !== accepted.artifactSha256) {
        fail(`runtime artifact changed after validation before activation; expected ${accepted.artifactSha256}, observed ${observed.sha256}`);
      }
    } else if (args.releaseMode === 'production') {
      fail('production supervisor refuses to spawn a runtime without accepted exact artifact evidence');
    }
    return baseSpawnImpl(executable, argv, spawnOptions);
  };

  return transactional.superviseDaemon(args, paths, initialRuntime, {
    ...options,
    remoteHeadFn,
    resolveChannelRefFn: baseResolveChannelRefFn,
    candidatePrepareFn,
    recordActivationFn,
    spawnImpl,
  });
}

async function validateProductionRuntime(args, paths, runtime, { env = process.env } = {}) {
  const persisted = transactional.readRuntimeActivationState(paths)?.current;
  if (
    persisted?.head?.toLowerCase?.() === runtime.head.toLowerCase() &&
    exactDigest(persisted.artifactSha256) &&
    persisted.releaseIntegrity?.mode === 'production' &&
    persisted.releaseIntegrity?.verified === true &&
    persisted.releaseIntegrity?.immutableRelease === true
  ) {
    // A new local manifest may already name the *next* release while this
    // last-known-good runtime was signed by the previous manifest. Preserve the
    // prior accepted release identity from the control-owned activation journal,
    // but independently re-hash the current runtime before trusting it again.
    const artifact = await runtimeArtifactSha256(runtime.runtimeDir);
    if (artifact.sha256 !== persisted.artifactSha256) {
      fail(`persisted production runtime artifact changed; expected ${persisted.artifactSha256}, observed ${artifact.sha256}`);
    }
    return {
      ...runtime,
      artifactSha256: artifact.sha256,
      releaseIntegrity: {
        mode: 'production',
        verified: true,
        immutableRelease: true,
        artifactSha256: artifact.sha256,
        manifestSha256: persisted.releaseIntegrity.manifestSha256 ?? null,
        keyId: persisted.releaseIntegrity.keyId ?? null,
        releaseHead: runtime.head,
      },
    };
  }

  const manifest = await readSignedReleaseManifest(args.releaseManifest, args.releasePublicKey);
  const integrity = await verifyRuntimeReleaseIntegrity({ args, runtime, manifest });
  const validation = await sandboxValidateRuntimeCandidate(paths, runtime, null, {
    expectedArtifactSha256: integrity.artifactSha256,
    env,
  });
  if (validation.artifactSha256 !== integrity.artifactSha256) {
    fail('production runtime sandbox validation did not preserve the signed artifact');
  }
  return { ...runtime, artifactSha256: integrity.artifactSha256, releaseIntegrity: integrity, validation };
}

export async function bootstrap(argv = process.argv.slice(2), runner) {
  transactional.assertSupportedNode();
  const args = parseBootstrapArgs(argv);
  const paths = transactional.resolveBootstrapPaths(args);
  const runtimeExists = existsSync(paths.runtime);

  let runtime = transactional.loadPersistedHealthyRuntime(paths, runner);
  if (!runtime) {
    runtime = transactional.ensureRuntime(runtimeExists ? { ...args, update: false } : args, paths, runner);
    runtime = { ...runtime, runtimeDir: paths.runtime };
  }

  if (args.releaseMode === 'production') {
    runtime = await validateProductionRuntime(args, paths, runtime);
  }

  process.stdout.write(
    `[patch-poller-bootstrap] channel=${args.channel} releaseMode=${args.releaseMode} ref=${runtime.ref} version=${runtime.version} head=${runtime.head}` +
    `${runtime.artifactSha256 ? ` artifactSha256=${runtime.artifactSha256}` : ''}\n`,
  );
  if (transactional.prepareLocalConfig(paths, runtime)) {
    process.stdout.write(
      `[patch-poller-bootstrap] Created safe local config: ${paths.config}\n` +
      '[patch-poller-bootstrap] Review execution/controller-plan policy and enable execution only when ready.\n' +
      '[patch-poller-bootstrap] Then run this same command again.\n',
    );
    return 0;
  }

  if (args.command === 'status' || args.command === 'stop') {
    return transactional.runPollerCli(args.command, paths, runtime, runner);
  }

  // In production, reaching this point means the exact signed/persisted runtime
  // passed the trusted release-integrity boundary. Doctor is now a
  // post-acceptance control-plane health check, not a pre-acceptance trust test.
  const doctorStatus = transactional.runPollerCli('doctor', paths, runtime, runner);
  if (doctorStatus !== 0 || args.command === 'doctor') return doctorStatus;

  if (args.command !== 'daemon' && args.command !== 'restart') {
    return transactional.runPollerCli(args.command, paths, runtime, runner);
  }

  await transactional.stopExistingDaemon(paths, runtime, runner);
  const controller = new AbortController();
  const requestStop = () => controller.abort();
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  try {
    return await superviseDaemon(
      { ...args, command: 'daemon' },
      paths,
      runtime,
      { runner, takeover: false, signal: controller.signal },
    );
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}
