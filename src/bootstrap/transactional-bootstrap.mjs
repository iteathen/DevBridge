import { createHash, verify as verifySignature } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as legacy from './legacy-bootstrap.mjs';
import { createSandboxProvider } from '../runtime/sandbox-provider.js';

export * from './legacy-bootstrap.mjs';

const ACTIVATION_PROTOCOL = 'patch-poller/runtime-activation-v1';
const RELEASE_MANIFEST_PROTOCOL = 'patch-poller/release-manifest-v1';
const RELEASE_REPOSITORY = 'iteathen/PATCH-POLLER';
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const DEFAULT_HEALTH_WINDOW_MS = 2_000;
const CHILD_RESTART_BACKOFF_MS = 5_000;
const UPDATE_CHECK_INTERVAL_MS = 60_000;

function defaultRunner(executable, args, options) {
  return spawnSync(executable, args, {
    ...options,
    shell: false,
    encoding: options.stdio === 'inherit' ? undefined : 'utf8',
    maxBuffer: CAPTURE_LIMIT,
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function updateCheckDelay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
function runtimeDirectory(paths, runtime) { return path.resolve(runtime?.runtimeDir ?? paths.runtime); }
function runtimePaths(paths, runtime) { return { ...paths, runtime: runtimeDirectory(paths, runtime) }; }
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function runtimeRecord(runtime, paths) {
  if (!runtime) return null;
  return {
    ref: runtime.ref,
    head: runtime.head,
    version: runtime.version,
    runtimeDir: runtimeDirectory(paths, runtime),
    cliPath: path.resolve(runtime.cliPath),
    artifactSha256: runtime.artifactSha256 ?? null,
    releaseMode: runtime.releaseMode ?? null,
  };
}

function activationRecord(state, paths, previous, candidate = null, extra = {}) {
  return {
    protocol: ACTIVATION_PROTOCOL,
    state,
    previous: runtimeRecord(previous, paths),
    candidate: runtimeRecord(candidate, paths),
    current: runtimeRecord(extra.current ?? previous, paths),
    failedCandidate: extra.failedCandidate ? runtimeRecord(extra.failedCandidate, paths) : null,
    error: extra.error ? { name: extra.error.name ?? 'Error', message: extra.error.message ?? String(extra.error) } : null,
    updatedAt: new Date().toISOString(),
  };
}

export function resolveBootstrapPaths(args, environment = process.env) {
  const base = legacy.resolveBootstrapPaths(args, environment);
  return { ...base, runtimeCandidates: path.join(base.home, 'runtime-candidates'), activationStateFile: path.join(base.home, 'runtime-activation.json') };
}

export function writeRuntimeActivationState(paths, value) {
  const filePath = paths.activationStateFile ?? path.join(paths.home, 'runtime-activation.json');
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, filePath);
  return value;
}

export function readRuntimeActivationState(paths) {
  const filePath = paths.activationStateFile ?? path.join(paths.home, 'runtime-activation.json');
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed?.protocol === ACTIVATION_PROTOCOL ? parsed : null;
  } catch { return null; }
}

export function runPollerCli(command, paths, runtime, runner = defaultRunner) { return legacy.runPollerCli(command, runtimePaths(paths, runtime), runtime, runner); }
export function runPollerCliCaptured(command, paths, runtime, runner = defaultRunner) { return legacy.runPollerCliCaptured(command, runtimePaths(paths, runtime), runtime, runner); }
export function prepareLocalConfig(paths, runtime = null) { return legacy.prepareLocalConfig(runtime ? runtimePaths(paths, runtime) : paths); }
export function spawnPollerDaemon(paths, runtime, spawnImpl = spawn) { return legacy.spawnPollerDaemon(runtimePaths(paths, runtime), runtime, spawnImpl); }
export async function stopExistingDaemon(paths, runtime, runner = defaultRunner, options = {}) {
  return legacy.stopExistingDaemon(paths, runtime, runner, {
    ...options,
    stopCommandFn: options.stopCommandFn ?? (() => runPollerCliCaptured('stop', paths, runtime, runner)),
    forceLegacyStopFn: options.forceLegacyStopFn ?? (() => legacy.forceTerminateLegacyDaemon(paths, runtime, runner)),
  });
}

function candidateEnvironment(source = process.env, isolatedHome = null) {
  const allowed = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR']
    : ['PATH', 'TMPDIR', 'TMP', 'TEMP'];
  const env = {};
  for (const name of allowed) if (source[name] != null) env[name] = source[name];
  if (isolatedHome) {
    env.HOME = isolatedHome;
    env.USERPROFILE = isolatedHome;
  }
  env.CI = '1';
  env.NO_COLOR = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.PATCH_POLLER_NONINTERACTIVE = '1';
  return env;
}

function checkedCommand(executable, args, { cwd, env, runner, label, timeout }) {
  const result = runner(executable, args, { cwd, env, stdio: 'pipe', timeout, shell: false, windowsHide: true });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${label} failed (exit ${result.status ?? 'spawn-error'})${detail ? `: ${detail.slice(-4000)}` : ''}`);
  }
  return result;
}

function canonicalReleasePayload(manifest) {
  return JSON.stringify({
    protocol: RELEASE_MANIFEST_PROTOCOL,
    repository: manifest.repository,
    commit: manifest.commit,
    treeSha256: manifest.treeSha256,
    createdAt: manifest.createdAt,
  });
}

export function candidateTreeSha256(runtimeDir) {
  const root = path.resolve(runtimeDir);
  const entries = [];
  const walk = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      if (prefix === '' && name === '.git') continue;
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`release candidate contains symbolic link ${relative}`);
      if (info.isDirectory()) { walk(absolute, relative); continue; }
      if (!info.isFile()) throw new Error(`release candidate contains unsupported filesystem object ${relative}`);
      const bytes = readFileSync(absolute);
      entries.push(`${relative}\0${info.mode & 0o777}\0${bytes.length}\0${createHash('sha256').update(bytes).digest('hex')}`);
    }
  };
  walk(root);
  return createHash('sha256').update(entries.join('\n'), 'utf8').digest('hex');
}

export function verifyProductionReleaseManifest(paths, runtime, environment = process.env) {
  const manifestFile = environment.PATCH_POLLER_RELEASE_MANIFEST_FILE;
  const publicKeyFile = environment.PATCH_POLLER_RELEASE_PUBLIC_KEY_FILE;
  if (!manifestFile || !publicKeyFile || !path.isAbsolute(manifestFile) || !path.isAbsolute(publicKeyFile)) {
    throw new Error('stable production updates require absolute PATCH_POLLER_RELEASE_MANIFEST_FILE and PATCH_POLLER_RELEASE_PUBLIC_KEY_FILE local paths');
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); }
  catch (error) { throw new Error(`could not parse trusted release manifest: ${error.message}`); }
  if (manifest?.protocol !== RELEASE_MANIFEST_PROTOCOL || manifest.repository !== RELEASE_REPOSITORY) throw new Error('trusted release manifest identity is invalid');
  if (!/^[0-9a-f]{40}$/u.test(manifest.commit ?? '') || !/^[0-9a-f]{64}$/u.test(manifest.treeSha256 ?? '') || typeof manifest.createdAt !== 'string') {
    throw new Error('trusted release manifest fields are invalid');
  }
  if (String(runtime.head).toLowerCase() !== manifest.commit) throw new Error(`release manifest commit ${manifest.commit} does not match candidate ${runtime.head}`);
  if (typeof manifest.signature !== 'string' || !/^[A-Za-z0-9+/=]+$/u.test(manifest.signature)) throw new Error('trusted release manifest signature is invalid');
  const publicKey = readFileSync(publicKeyFile, 'utf8');
  const valid = verifySignature(null, Buffer.from(canonicalReleasePayload(manifest), 'utf8'), publicKey, Buffer.from(manifest.signature, 'base64'));
  if (!valid) throw new Error('trusted release manifest signature verification failed');
  const observedTree = candidateTreeSha256(runtimeDirectory(paths, runtime));
  if (observedTree !== manifest.treeSha256) throw new Error(`release manifest tree digest mismatch; expected ${manifest.treeSha256}, observed ${observedTree}`);
  return { mode: 'production', manifest: { repository: manifest.repository, commit: manifest.commit, treeSha256: manifest.treeSha256, createdAt: manifest.createdAt } };
}

function validationConfig(paths, scratch) {
  return {
    version: 1,
    github: {
      queueRepository: RELEASE_REPOSITORY,
      trustedActorIds: ['1'],
      auth: { mode: 'environment', environmentVariables: ['PATCH_POLLER_VALIDATION_TOKEN'], githubCliExecutable: 'gh', hostname: 'github.com' },
      rateLimit: {},
    },
    workspace: { root: path.join(scratch, 'workspaces'), allowCreate: true, allowedOwners: ['iteathen'], externalReadRoots: [] },
    state: { directory: path.join(scratch, 'state') },
    execution: { enabled: false, controllerPlansEnabled: true, modelAdaptersEnabled: false, sandbox: { provider: 'none' } },
    publication: { autoPushTaskBranches: false },
    status: {},
    tools: {},
  };
}

async function sandboxedCandidateCommand(provider, executable, args, { cwd, env, scratch, runner, label, timeout }) {
  const launch = await provider.prepareSpawn({
    executable,
    args,
    cwd,
    environment: env,
    sandbox: { projectRoot: cwd, projectWritable: false, writableRoots: [scratch], readOnlyRoots: [], network: 'deny' },
  });
  return checkedCommand(launch.executable, launch.args, { cwd: launch.cwd, env: launch.environment, runner, label, timeout });
}

export async function validateRuntimeCandidate(paths, runtime, runner = defaultRunner, {
  environment = process.env,
  sandboxProvider = null,
} = {}) {
  const cwd = runtimeDirectory(paths, runtime);
  const scratch = path.join(paths.home, 'candidate-validation', String(runtime.head).toLowerCase());
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(scratch, 'home'), { recursive: true, mode: 0o700 });
  const env = candidateEnvironment(environment, path.join(scratch, 'home'));
  const provider = sandboxProvider ?? createSandboxProvider({
    provider: environment.PATCH_POLLER_BOOTSTRAP_SANDBOX_PROVIDER ?? 'auto',
    executable: environment.PATCH_POLLER_BOOTSTRAP_SANDBOX_EXECUTABLE ?? 'bwrap',
  }, { env: environment, externalReadRoots: [] });
  const status = await provider.verify();
  if (!status.verified) throw new Error(`candidate validation requires verified sandbox containment: ${status.reason ?? status.verification}`);
  const beforeDigest = candidateTreeSha256(cwd);
  const validationConfigFile = path.join(scratch, 'config.json');
  writeFileSync(validationConfigFile, `${JSON.stringify(validationConfig(paths, scratch), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await sandboxedCandidateCommand(provider, process.execPath, [path.join(cwd, 'src', 'bootstrap', 'repository-preflight.mjs')], {
      cwd, env, scratch, runner, label: 'candidate cheap preflight', timeout: 4 * 60_000,
    });
    await sandboxedCandidateCommand(provider, process.execPath, ['--test'], {
      cwd, env, scratch, runner, label: 'candidate test suite', timeout: 10 * 60_000,
    });
    await sandboxedCandidateCommand(provider, process.execPath, [path.join(cwd, 'src', 'cli.js'), 'doctor', '--config', validationConfigFile], {
      cwd, env, scratch, runner, label: 'candidate isolated doctor', timeout: 4 * 60_000,
    });
    const afterDigest = candidateTreeSha256(cwd);
    if (afterDigest !== beforeDigest) throw new Error(`candidate validation changed tested runtime bytes: ${beforeDigest} -> ${afterDigest}`);
    return { preflight: 'passed', tests: 'passed', doctor: 'passed', sandbox: status.provider, artifactSha256: afterDigest };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function candidateRuntimePath(paths, head) {
  if (!/^[0-9a-f]{40}$/iu.test(String(head))) throw new Error('candidate runtime head must be an exact 40-hex SHA');
  const root = paths.runtimeCandidates ?? path.join(paths.home, 'runtime-candidates');
  return path.join(root, String(head).toLowerCase());
}

export async function prepareRuntimeCandidate(args, paths, {
  desiredRef,
  desiredHead,
  runner = defaultRunner,
  ensureRuntimeFn = legacy.ensureRuntime,
  validateCandidateFn = validateRuntimeCandidate,
  verifyProductionReleaseFn = verifyProductionReleaseManifest,
  environment = process.env,
} = {}) {
  if (!desiredRef || !/^[0-9a-f]{40}$/iu.test(String(desiredHead))) throw new Error('candidate preparation requires a trusted ref and exact head');
  const runtimeDir = candidateRuntimePath(paths, desiredHead);
  const candidatePaths = { ...paths, runtime: runtimeDir };
  const candidate = ensureRuntimeFn({ ...args, update: true }, candidatePaths, runner);
  if (candidate.ref !== desiredRef || candidate.head.toLowerCase() !== String(desiredHead).toLowerCase()) {
    throw new Error(`candidate changed during preparation; expected ${desiredRef}@${desiredHead}, observed ${candidate.ref}@${candidate.head}`);
  }
  let runtime = { ...candidate, runtimeDir, releaseMode: args.channel === 'stable' ? 'production' : 'development' };
  const release = args.channel === 'stable' ? verifyProductionReleaseFn(paths, runtime, environment) : { mode: 'development' };
  const validation = await validateCandidateFn(paths, runtime, runner, { environment });
  const exactDigest = candidateTreeSha256(runtimeDir);
  if (validation?.artifactSha256 && validation.artifactSha256 !== exactDigest) throw new Error('validated artifact digest no longer matches exact candidate bytes');
  if (release.manifest?.treeSha256 && release.manifest.treeSha256 !== exactDigest) throw new Error('signed release artifact digest no longer matches exact candidate bytes');
  runtime = { ...runtime, artifactSha256: exactDigest, releaseMode: release.mode };
  return runtime;
}

export function loadPersistedHealthyRuntime(paths, runner = defaultRunner, { ensureRuntimeFn = legacy.ensureRuntime } = {}) {
  const record = readRuntimeActivationState(paths);
  const current = record?.current;
  if (!current || !['healthy', 'rolled-back', 'candidate-failed'].includes(record.state)) return null;
  const home = path.resolve(paths.home ?? path.dirname(paths.runtime));
  const runtimeDir = path.resolve(current.runtimeDir ?? '');
  if (!isWithin(home, runtimeDir)) return null;
  try {
    const observed = ensureRuntimeFn({ channel: 'testing', update: false }, { ...paths, runtime: runtimeDir }, runner);
    if (observed.head.toLowerCase() !== String(current.head).toLowerCase()) return null;
    const artifactSha256 = candidateTreeSha256(runtimeDir);
    if (current.artifactSha256 && artifactSha256 !== current.artifactSha256) return null;
    return { ...observed, ref: current.ref, runtimeDir, artifactSha256, releaseMode: current.releaseMode ?? null };
  } catch { return null; }
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
async function recordActivation(recordActivationFn, paths, record) { return recordActivationFn(paths, record); }

export async function superviseDaemon(args, paths, initialRuntime, {
  runner = defaultRunner,
  spawnImpl = spawn,
  updateIntervalMs = UPDATE_CHECK_INTERVAL_MS,
  restartBackoffMs = CHILD_RESTART_BACKOFF_MS,
  healthWindowMs = DEFAULT_HEALTH_WINDOW_MS,
  maxIterations = Number.POSITIVE_INFINITY,
  takeover = true,
  remoteHeadFn = legacy.remoteBranchHead,
  candidatePrepareFn = prepareRuntimeCandidate,
  runPollerCliFn = runPollerCli,
  stopExistingFn = stopExistingDaemon,
  updateCheckDelayFn = updateCheckDelay,
  healthCheckDelayFn = delay,
  delayFn = delay,
  signal = null,
  resolveChannelRefFn = legacy.resolveChannelRef,
  recordActivationFn = writeRuntimeActivationState,
  initialActivation = null,
} = {}) {
  let runtime = initialRuntime;
  let ref = runtime.ref === 'existing' ? resolveChannelRefFn(args.channel, { paths, runner }) : runtime.ref;
  let iterations = 0;
  let activation = initialActivation;
  let failedCandidateHead = null;
  let firstUpdateCheck = true;

  if (takeover) await stopExistingFn(paths, runtime, runner);

  while (iterations < maxIterations) {
    iterations += 1;
    const child = spawnPollerDaemon(paths, runtime, spawnImpl);
    process.stdout.write(`[patch-poller-supervisor] daemon-started runtime=${runtime.head}\n`);
    const exitPromise = childExit(child);

    if (activation && runtime.head === activation.candidate.head) {
      const outcome = await Promise.race([
        exitPromise.then((exit) => ({ type: 'exit', exit })),
        healthCheckDelayFn(healthWindowMs).then(() => ({ type: 'health-window' })),
      ]);
      if (outcome.type === 'exit') {
        await recordActivation(recordActivationFn, paths, activationRecord('rolled-back', paths, activation.previous, activation.candidate, {
          current: activation.previous,
          failedCandidate: activation.candidate,
          error: new Error(`candidate daemon exited before health window (code=${outcome.exit.code ?? 'null'}, signal=${outcome.exit.signal ?? 'none'})`),
        }));
        process.stderr.write(`[patch-poller-supervisor] candidate-health-failed head=${activation.candidate.head}; rolling back to ${activation.previous.head}\n`);
        runtime = activation.previous;
        ref = runtime.ref;
        failedCandidateHead = activation.candidate.head;
        activation = null;
        await delayFn(restartBackoffMs);
        continue;
      }

      const doctorStatus = runPollerCliFn('doctor', paths, runtime, runner);
      if (doctorStatus !== 0) {
        await recordActivation(recordActivationFn, paths, activationRecord('health-failed', paths, activation.previous, activation.candidate, {
          current: activation.previous,
          failedCandidate: activation.candidate,
          error: new Error(`candidate health doctor failed with exit ${doctorStatus}`),
        }));
        const stopStatus = runPollerCliFn('stop', paths, runtime, runner);
        if (stopStatus !== 0 && stopStatus !== 3) throw new Error(`could not stop unhealthy candidate daemon (exit ${stopStatus})`);
        await exitPromise;
        runtime = activation.previous;
        ref = runtime.ref;
        failedCandidateHead = activation.candidate.head;
        activation = null;
        await recordActivation(recordActivationFn, paths, activationRecord('rolled-back', paths, runtime, null, { current: runtime }));
        continue;
      }

      await recordActivation(recordActivationFn, paths, activationRecord('healthy', paths, activation.previous, activation.candidate, { current: activation.candidate }));
      process.stdout.write(`[patch-poller-supervisor] candidate-healthy head=${activation.candidate.head} previous=${activation.previous.head}\n`);
      ref = activation.candidate.ref;
      activation = null;
    }

    let updatePending = false;
    let pendingActivation = null;
    let operatorStopPending = false;
    const abortPromise = signal
      ? new Promise((resolve) => {
          if (signal.aborted) resolve({ type: 'operator-stop' });
          else signal.addEventListener('abort', () => resolve({ type: 'operator-stop' }), { once: true });
        })
      : new Promise(() => {});

    while (true) {
      const waits = [exitPromise.then((exit) => ({ type: 'exit', exit })), abortPromise];
      if (args.update && !updatePending && !operatorStopPending) {
        const checkDelay = firstUpdateCheck ? 0 : updateIntervalMs;
        waits.push(updateCheckDelayFn(checkDelay).then(() => ({ type: 'update-check' })));
      }
      const outcome = await Promise.race(waits);

      if (outcome.type === 'operator-stop') {
        if (!operatorStopPending) {
          operatorStopPending = true;
          const stopStatus = runPollerCliFn('stop', paths, runtime, runner);
          if (stopStatus !== 0 && stopStatus !== 3) process.stderr.write(`[patch-poller-supervisor] operator-stop-request-exit=${stopStatus}; waiting for daemon boundary\n`);
        }
        continue;
      }

      if (outcome.type === 'update-check') {
        firstUpdateCheck = false;
        if (!args.update || updatePending) continue;
        let remoteHead = null;
        let desiredRef = ref;
        try {
          desiredRef = resolveChannelRefFn(args.channel, { paths, runner });
          remoteHead = remoteHeadFn(desiredRef, { paths, runner });
        } catch (error) {
          process.stderr.write(`[patch-poller-supervisor] update-check-error ${error.message}\n`);
          continue;
        }
        if (!remoteHead || (remoteHead === runtime.head && desiredRef === ref) || remoteHead === failedCandidateHead) continue;

        const planned = { ref: desiredRef, head: remoteHead, version: runtime.version, runtimeDir: candidateRuntimePath(paths, remoteHead), cliPath: path.join(candidateRuntimePath(paths, remoteHead), 'src', 'cli.js'), releaseMode: args.channel === 'stable' ? 'production' : 'development' };
        await recordActivation(recordActivationFn, paths, activationRecord('candidate-planned', paths, runtime, planned, { current: runtime }));
        let candidate;
        try {
          candidate = await candidatePrepareFn(args, paths, { desiredRef, desiredHead: remoteHead, previousRuntime: runtime, runner });
        } catch (error) {
          failedCandidateHead = remoteHead;
          await recordActivation(recordActivationFn, paths, activationRecord('candidate-failed', paths, runtime, planned, { current: runtime, failedCandidate: planned, error }));
          process.stderr.write(`[patch-poller-supervisor] candidate-validation-failed ${error.message}; current runtime remains ${runtime.head}\n`);
          continue;
        }

        if (signal?.aborted) {
          operatorStopPending = true;
          const stopStatus = runPollerCliFn('stop', paths, runtime, runner);
          if (stopStatus !== 0 && stopStatus !== 3) process.stderr.write(`[patch-poller-supervisor] operator-stop-request-exit=${stopStatus}\n`);
          continue;
        }

        pendingActivation = { previous: runtime, candidate };
        updatePending = true;
        await recordActivation(recordActivationFn, paths, activationRecord('candidate-validated', paths, runtime, candidate, { current: runtime }));
        await recordActivation(recordActivationFn, paths, activationRecord('drain-requested', paths, runtime, candidate, { current: runtime }));
        process.stdout.write(`[patch-poller-supervisor] candidate-validated current=${runtime.head} next=${candidate.head}; requesting daemon drain\n`);
        const stopStatus = runPollerCliFn('stop', paths, runtime, runner);
        if (stopStatus !== 0 && stopStatus !== 3) process.stderr.write(`[patch-poller-supervisor] stop-request-exit=${stopStatus}; waiting for daemon boundary\n`);
        continue;
      }

      if (operatorStopPending) {
        process.stdout.write('[patch-poller-supervisor] daemon-stopped cleanly; supervisor exiting\n');
        return 0;
      }
      if (updatePending && pendingActivation) {
        activation = pendingActivation;
        runtime = pendingActivation.candidate;
        ref = runtime.ref;
        await recordActivation(recordActivationFn, paths, activationRecord('activating', paths, pendingActivation.previous, runtime, { current: pendingActivation.previous }));
        break;
      }
      if (outcome.exit.code === 0) {
        process.stdout.write('[patch-poller-supervisor] daemon-stopped cleanly; supervisor exiting\n');
        return 0;
      }
      process.stderr.write(`[patch-poller-supervisor] daemon-exited code=${outcome.exit.code ?? 'null'} signal=${outcome.exit.signal ?? 'none'}; restarting\n`);
      await delayFn(restartBackoffMs);
      break;
    }
  }
  return 0;
}

export async function bootstrap(argv = process.argv.slice(2), runner = defaultRunner) {
  legacy.assertSupportedNode();
  const args = legacy.parseBootstrapArgs(argv);
  const paths = resolveBootstrapPaths(args);
  const runtimeExists = existsSync(paths.runtime);

  let runtime = loadPersistedHealthyRuntime(paths, runner);
  if (!runtime) {
    runtime = legacy.ensureRuntime(runtimeExists ? { ...args, update: false } : args, paths, runner);
    runtime = { ...runtime, runtimeDir: paths.runtime, releaseMode: args.channel === 'stable' ? 'production' : 'development' };
  }
  if (args.channel === 'stable') {
    const release = verifyProductionReleaseManifest(paths, runtime, process.env);
    runtime = { ...runtime, artifactSha256: release.manifest.treeSha256, releaseMode: 'production' };
  } else {
    runtime = { ...runtime, artifactSha256: runtime.artifactSha256 ?? candidateTreeSha256(runtimeDirectory(paths, runtime)), releaseMode: 'development' };
  }

  process.stdout.write(`[patch-poller-bootstrap] channel=${args.channel} release-mode=${runtime.releaseMode} ref=${runtime.ref} version=${runtime.version} head=${runtime.head} artifact=${runtime.artifactSha256}\n`);
  if (prepareLocalConfig(paths, runtime)) {
    process.stdout.write(
      `[patch-poller-bootstrap] Created safe local config: ${paths.config}\n` +
      '[patch-poller-bootstrap] Review execution/controller-plan policy and enable execution only when ready.\n' +
      '[patch-poller-bootstrap] Stable production mode additionally requires a locally trusted signed release manifest and public key.\n' +
      '[patch-poller-bootstrap] Then run this same command again.\n',
    );
    return 0;
  }

  if (args.command === 'status' || args.command === 'stop') return runPollerCli(args.command, paths, runtime, runner);
  const doctorStatus = runPollerCli('doctor', paths, runtime, runner);
  if (doctorStatus !== 0 || args.command === 'doctor') return doctorStatus;
  if (args.command !== 'daemon' && args.command !== 'restart') return runPollerCli(args.command, paths, runtime, runner);

  await stopExistingDaemon(paths, runtime, runner);
  const controller = new AbortController();
  const requestStop = () => controller.abort();
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  try {
    return await superviseDaemon({ ...args, command: 'daemon' }, paths, runtime, { runner, takeover: false, signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}
