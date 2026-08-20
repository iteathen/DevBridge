import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as transactional from './transactional-bootstrap.mjs';
import { validateRuntimeCandidate as validateCandidateExecution } from './candidate-validator.mjs';
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

export const validateRuntimeCandidate = validateCandidateExecution;

export function observeRuntimeUpdate(args, paths, runtime, runner) {
  if (!args.update) return { state: 'disabled', channel: args.channel, currentHead: runtime.head };
  if (args.releaseMode === 'production') {
    return { state: 'release-policy', channel: args.channel, currentHead: runtime.head };
  }
  let ref;
  let head;
  try {
    ref = transactional.resolveChannelRef(args.channel, { paths, runner });
    head = transactional.remoteBranchHead(ref, { paths, runner });
  } catch (error) {
    return { state: 'unknown', channel: args.channel, currentHead: runtime.head, reason: String(error?.message ?? error) };
  }
  if (!head) return { state: 'unknown', channel: args.channel, ref, currentHead: runtime.head };
  return {
    state: head === runtime.head.toLowerCase() ? 'current' : 'available',
    channel: args.channel,
    ref,
    currentHead: runtime.head,
    desiredHead: head,
  };
}

export async function prepareRuntimeCandidate(args, paths, {
  desiredRef,
  desiredHead,
  runner,
  ensureRuntimeFn = transactional.ensureRuntime,
  validateCandidateFn = validateCandidateExecution,
  releaseManifest = null,
  env = process.env,
} = {}) {
  if (!desiredRef || !/^[0-9a-f]{40}$/iu.test(String(desiredHead))) {
    fail('candidate preparation requires a trusted ref and exact head');
  }
  const runtimeDir = transactional.candidateRuntimePath(paths, desiredHead);
  const candidatePaths = { ...paths, runtime: runtimeDir };
  const candidate = ensureRuntimeFn({ ...args, update: true }, candidatePaths, runner);
  if (candidate.stage0Protocol !== transactional.STAGE0_PROTOCOL) {
    fail(`candidate requires incompatible stage-0 protocol ${candidate.stage0Protocol}; expected ${transactional.STAGE0_PROTOCOL}`);
  }
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
    fail('candidate artifact changed after execution validation');
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
    validationExecution: known.validation?.execution ?? null,
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
      // returns an exact digest after execution validation.
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
  const validation = await validateCandidateExecution(paths, runtime, null, {
    expectedArtifactSha256: integrity.artifactSha256,
    env,
  });
  if (validation.artifactSha256 !== integrity.artifactSha256) {
    fail('production runtime execution validation did not preserve the signed artifact');
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

  const launcher = transactional.syncInstalledLauncher(paths, runtime);

  process.stdout.write(
    `[devbridge-bootstrap] channel=${args.channel} releaseMode=${args.releaseMode} ref=${runtime.ref} version=${runtime.version} head=${runtime.head}` +
    `${runtime.artifactSha256 ? ` artifactSha256=${runtime.artifactSha256}` : ''}` +
    `${launcher.changed ? ' launcher=updated' : ''}\n`,
  );
  if (args.command === 'uninstall') {
    if (existsSync(paths.config)) transactional.migrateLocalConfig(paths);
    if (existsSync(paths.config)) await transactional.stopExistingDaemon(paths, runtime, runner);
    const { uninstall } = await import('./uninstall.mjs');
    await uninstall(paths, argv);
    return 0;
  }
  const createdConfig = transactional.prepareLocalConfig(paths, runtime);
  if (createdConfig) {
    process.stdout.write(
      `[devbridge-bootstrap] Created safe local config: ${paths.config}\n` +
      '[devbridge-bootstrap] Review execution/controller-plan policy and enable execution only when ready.\n' +
      '[devbridge-bootstrap] Continuing with first-run setup; use --setup to re-enter it later.\n',
    );
  }
  const configMigration = transactional.migrateLocalConfig(paths);
  if (configMigration.changed) {
    process.stdout.write(`[devbridge-bootstrap] Migrated local configuration; backup=${configMigration.backup}\n`);
  }

  if (args.command === 'logs') {
    const log = transactional.readBackgroundLog(paths);
    process.stdout.write(log.available ? log.text : `[devbridge-bootstrap] no headless supervisor log exists at ${log.file}\n`);
    return 0;
  }
  if (args.command === 'status' || args.command === 'stop') {
    return transactional.runDevBridgeCli(args.command, paths, runtime, runner);
  }

  const setupRequired = args.command === 'setup' ? false : transactional.readSetupState(paths) == null;
  if (setupRequired && args.command === 'doctor') {
    process.stdout.write('[devbridge-bootstrap] setup=required; run the setup command to configure repositories, task authors, and environments.\n');
  }
  if (args.command === 'setup' || (setupRequired && args.command !== 'doctor')) {
    const selectedChannel = await transactional.selectBootstrapChannel(paths, args.channel, argv);
    args.channel = selectedChannel;
    let discovery = null;
    let discoveryError = null;
    let loadConfig;
    try {
      const [configModule, { createConfigurationDiscovery }] = await Promise.all([
        import('../config.js'),
        import('./configuration-discovery.mjs'),
      ]);
      ({ loadConfig } = configModule);
      discovery = await createConfigurationDiscovery(await loadConfig(paths.config));
    } catch (error) {
      discoveryError = error;
    }
    const configuration = await transactional.configureLocalConfig(paths, argv, { discovery, discoveryError });
    if (!configuration.completed) return 0;
    if (!loadConfig) ({ loadConfig } = await import('../config.js'));
    const configured = { ...await loadConfig(paths.config), __file: paths.config };
    const { setupEnvironments } = await import('./environment-setup.mjs');
    const environments = await setupEnvironments(configured, configuration.repositoryOptions, argv);
    if (!environments.completed) return 0;
    const { recordInstallEntries } = await import('./install-manifest.mjs');
    const entries = [
      { kind: 'path', role: 'config', path: paths.config, ownership: createdConfig ? 'created' : 'verified-managed' },
      { kind: 'path', role: 'bootstrap-policy', path: paths.policy, ownership: 'created' },
      { kind: 'path', role: 'state', path: configured.state.directory, ownership: 'created-or-verified-managed' },
      { kind: 'path', role: 'workspace', path: configured.workspace.root, ownership: 'authorized-managed-root' },
      { kind: 'path', role: 'setup-state', path: paths.setupStateFile, ownership: 'created' },
      { kind: 'path', role: 'runtime-candidates', path: paths.runtimeCandidates, ownership: 'created' },
      { kind: 'path', role: 'activation-state', path: paths.activationStateFile, ownership: 'created' },
      ...environments.managedEnvironments.map((entry) => ({
        kind: 'environment',
        role: 'repository-environment',
        identity: entry.identity,
        subject: entry.subject,
        repository: entry.repository,
        stateDirectory: environments.stateDirectory,
        ownership: 'provider-verified-managed',
      })),
    ];
    if (environments.sourceIdentity) entries.push({
      kind: 'image',
      role: 'environment-source',
      identity: environments.sourceIdentity,
      stateDirectory: environments.stateDirectory,
      ownership: 'referenced',
    });
    if (configMigration.changed) entries.push({ kind: 'path', role: 'config-backup', path: configMigration.backup, ownership: 'created' });
    if (configuration.backup) entries.push({ kind: 'path', role: 'config-backup', path: configuration.backup, ownership: 'created' });
    await recordInstallEntries(paths, entries);
    transactional.persistBootstrapChannel(paths, selectedChannel);
    transactional.writeSetupState(paths, {
      channel: selectedChannel,
      repositories: configured.github.queueRepositories,
      trustedTaskAuthorIds: configured.github.trustedActorIds,
      environments: environments.selected,
      executionEnabled: environments.executionEnabled,
    });
    process.stdout.write('[devbridge-bootstrap] setup=complete; normal launches are locked out of setup unless setup or --setup is explicitly supplied.\n');
    if (args.command === 'setup') return 0;
  }

  if (args.command === 'doctor' || args.command === 'install') {
    const update = observeRuntimeUpdate(args, paths, runtime, runner);
    if (update.state === 'unknown') {
      process.stdout.write(`[devbridge-bootstrap] update=unknown channel=${args.channel} reason=remote-unavailable\n`);
    } else if (update.state === 'current') {
      process.stdout.write(`[devbridge-bootstrap] update=current channel=${args.channel} head=${runtime.head}\n`);
    } else if (update.state === 'release-policy') {
      process.stdout.write(`[devbridge-bootstrap] update=release-policy channel=${args.channel}; signed release policy controls availability\n`);
    } else if (update.state === 'disabled') {
      process.stdout.write(`[devbridge-bootstrap] update=disabled channel=${args.channel}; remove --no-update to check availability\n`);
    } else {
      process.stdout.write(
        `[devbridge-bootstrap] update=available channel=${args.channel} current=${runtime.head} next=${update.desiredHead}\n` +
        '[devbridge-bootstrap] Run this launcher with the update command to validate, activate, and launch it.\n',
      );
    }
  }

  // In production, reaching this point means the exact signed/persisted runtime
  // passed the trusted release-integrity boundary. Doctor is now a
  // post-acceptance control-plane health check, not a pre-acceptance trust test.
  const doctorStatus = transactional.runDevBridgeCli('doctor', paths, runtime, runner);
  if (doctorStatus !== 0 || args.command === 'doctor' || args.command === 'install') return doctorStatus;

  if (args.command === 'start') {
    const observed = transactional.runDevBridgeCliCaptured('status', paths, runtime, runner);
    if (observed.status !== 0) throw new Error(`Could not inspect daemon status before headless start (exit ${observed.status}).`);
    let daemonStatus;
    try { daemonStatus = JSON.parse(observed.stdout); }
    catch { throw new Error('Daemon status returned invalid control-plane JSON before headless start.'); }
    if (daemonStatus.activeLock === true) {
      process.stdout.write(`[devbridge-bootstrap] headless supervisor already active pid=${daemonStatus.pid ?? 'unknown'}\n`);
      return 0;
    }
    const started = transactional.spawnBackgroundBootstrap(argv, paths);
    const { recordInstallEntries } = await import('./install-manifest.mjs');
    await recordInstallEntries(paths, [
      { kind: 'path', role: 'logs', path: path.dirname(started.logFile), ownership: 'created' },
    ]);
    process.stdout.write(`[devbridge-bootstrap] headless supervisor started pid=${started.pid} log=${started.logFile}\n`);
    return 0;
  }

  if (args.command !== 'daemon' && args.command !== 'restart' && args.command !== 'update') {
    return transactional.runDevBridgeCli(args.command, paths, runtime, runner);
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
      { runner, stopExisting: false, signal: controller.signal },
    );
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}
