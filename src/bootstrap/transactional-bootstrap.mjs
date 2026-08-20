import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as runtimeCore from './runtime-bootstrap.mjs';

export * from './runtime-bootstrap.mjs';

const ACTIVATION_PROTOCOL = 'devbridge/runtime-activation-v1';
const SETUP_PROTOCOL = 'devbridge/setup-state-v1';
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

function runtimeDirectory(paths, runtime) {
  return path.resolve(runtime?.runtimeDir ?? paths.runtime);
}

function runtimePaths(paths, runtime) {
  return { ...paths, runtime: runtimeDirectory(paths, runtime) };
}

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
  const base = runtimeCore.resolveBootstrapPaths(args, environment);
  return {
    ...base,
    runtimeCandidates: path.join(base.home, 'runtime-candidates'),
    activationStateFile: path.join(base.home, 'runtime-activation.json'),
    setupStateFile: path.join(base.home, 'setup-state.json'),
    installManifest: path.join(base.home, 'install-manifest.json'),
  };
}

export function readSetupState(paths) {
  if (!existsSync(paths.setupStateFile)) return null;
  try {
    const value = JSON.parse(readFileSync(paths.setupStateFile, 'utf8'));
    if (value?.protocol !== SETUP_PROTOCOL || value.state !== 'complete') {
      throw new Error('setup state has an unsupported protocol or incomplete state');
    }
    return value;
  } catch (error) {
    throw new Error(`DevBridge setup state is invalid; explicitly run setup to replace it: ${error.message}`);
  }
}

export function writeSetupState(paths, value) {
  const record = { protocol: SETUP_PROTOCOL, state: 'complete', ...value, updatedAt: new Date().toISOString() };
  const temp = `${paths.setupStateFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, paths.setupStateFile);
  return record;
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
  } catch {
    return null;
  }
}

export function runDevBridgeCli(command, paths, runtime, runner = defaultRunner) {
  return runtimeCore.runDevBridgeCli(command, runtimePaths(paths, runtime), runtime, runner);
}

export function runDevBridgeCliCaptured(command, paths, runtime, runner = defaultRunner) {
  return runtimeCore.runDevBridgeCliCaptured(command, runtimePaths(paths, runtime), runtime, runner);
}

export function prepareLocalConfig(paths, runtime = null) {
  return runtimeCore.prepareLocalConfig(runtime ? runtimePaths(paths, runtime) : paths);
}

export async function selectBootstrapChannel(paths, current, argv, options) {
  return runtimeCore.selectBootstrapChannel(paths, current, argv, options);
}

export function persistBootstrapChannel(paths, channel) {
  return runtimeCore.persistBootstrapChannel(paths, channel);
}

export function migrateLocalConfig(paths) {
  return runtimeCore.migrateLocalConfig(paths);
}

export async function configureLocalConfig(paths, argv, options) {
  return runtimeCore.configureLocalConfig(paths, argv, options);
}

export function spawnDevBridgeDaemon(paths, runtime, spawnImpl = spawn) {
  return runtimeCore.spawnDevBridgeDaemon(runtimePaths(paths, runtime), runtime, spawnImpl);
}

export function spawnBackgroundBootstrap(argv, paths, spawnImpl = spawn) {
  return runtimeCore.spawnBackgroundBootstrap(argv, paths, spawnImpl);
}

export function readBackgroundLog(paths, options) {
  return runtimeCore.readBackgroundLog(paths, options);
}

export function syncInstalledLauncher(paths, runtime, options) {
  return runtimeCore.syncInstalledLauncher(paths, runtime, options);
}

export async function stopExistingDaemon(paths, runtime, runner = defaultRunner, options = {}) {
  return runtimeCore.stopExistingDaemon(paths, runtime, runner, {
    ...options,
    stopCommandFn: options.stopCommandFn ?? (() => runDevBridgeCliCaptured('stop', paths, runtime, runner)),
  });
}

function candidateEnvironment(source = process.env) {
  const allowed = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE']
    : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP'];
  const env = {};
  for (const name of allowed) if (source[name] != null) env[name] = source[name];
  env.CI = '1';
  env.NO_COLOR = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function checkedCommand(executable, args, { cwd, env, runner, label, timeout }) {
  const result = runner(executable, args, {
    cwd,
    env,
    stdio: 'pipe',
    timeout,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${label} failed (exit ${result.status ?? 'spawn-error'})${detail ? `: ${detail.slice(-4000)}` : ''}`);
  }
  return result;
}

export function validateRuntimeCandidate(paths, runtime, runner = defaultRunner, { runDoctorFn = runDevBridgeCli } = {}) {
  const cwd = runtimeDirectory(paths, runtime);
  const env = candidateEnvironment();
  checkedCommand(process.execPath, [path.join(cwd, 'src', 'bootstrap', 'repository-preflight.mjs')], {
    cwd, env, runner, label: 'candidate cheap preflight', timeout: 4 * 60_000,
  });
  checkedCommand(process.execPath, ['--test'], {
    cwd, env, runner, label: 'candidate test suite', timeout: 10 * 60_000,
  });
  const doctorStatus = runDoctorFn('doctor', paths, runtime, runner);
  if (doctorStatus !== 0) throw new Error(`candidate doctor failed with exit ${doctorStatus}`);
  return { preflight: 'passed', syntax: 'passed', tests: 'passed', doctor: 'passed' };
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
  ensureRuntimeFn = runtimeCore.ensureRuntime,
  validateCandidateFn = validateRuntimeCandidate,
} = {}) {
  if (!desiredRef || !/^[0-9a-f]{40}$/iu.test(String(desiredHead))) throw new Error('candidate preparation requires a trusted ref and exact head');
  const runtimeDir = candidateRuntimePath(paths, desiredHead);
  const candidatePaths = { ...paths, runtime: runtimeDir };
  const candidate = ensureRuntimeFn({ ...args, update: true }, candidatePaths, runner);
  if (candidate.ref !== desiredRef || candidate.head.toLowerCase() !== String(desiredHead).toLowerCase()) {
    throw new Error(`candidate changed during preparation; expected ${desiredRef}@${desiredHead}, observed ${candidate.ref}@${candidate.head}`);
  }
  const runtime = { ...candidate, runtimeDir };
  validateCandidateFn(paths, runtime, runner);
  return runtime;
}

export function loadPersistedHealthyRuntime(paths, runner = defaultRunner, { ensureRuntimeFn = runtimeCore.ensureRuntime } = {}) {
  const record = readRuntimeActivationState(paths);
  const current = record?.current;
  if (!current || !['healthy', 'rolled-back', 'candidate-failed'].includes(record.state)) return null;
  const home = path.resolve(paths.home ?? path.dirname(paths.runtime));
  const runtimeDir = path.resolve(current.runtimeDir ?? '');
  if (!isWithin(home, runtimeDir)) return null;
  try {
    const observed = ensureRuntimeFn({ channel: 'testing', update: false }, { ...paths, runtime: runtimeDir }, runner);
    if (observed.stage0Protocol !== runtimeCore.STAGE0_PROTOCOL) return null;
    if (observed.head.toLowerCase() !== String(current.head).toLowerCase()) return null;
    return { ...observed, ref: current.ref, runtimeDir };
  } catch {
    return null;
  }
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function recordActivation(recordActivationFn, paths, record) {
  return recordActivationFn(paths, record);
}

export async function superviseDaemon(args, paths, initialRuntime, {
  runner = defaultRunner,
  spawnImpl = spawn,
  updateIntervalMs = UPDATE_CHECK_INTERVAL_MS,
  restartBackoffMs = CHILD_RESTART_BACKOFF_MS,
  healthWindowMs = DEFAULT_HEALTH_WINDOW_MS,
  maxIterations = Number.POSITIVE_INFINITY,
  stopExisting = true,
  remoteHeadFn = runtimeCore.remoteBranchHead,
  candidatePrepareFn = prepareRuntimeCandidate,
  runDevBridgeCliFn = runDevBridgeCli,
  stopExistingFn = stopExistingDaemon,
  updateCheckDelayFn = updateCheckDelay,
  healthCheckDelayFn = delay,
  delayFn = delay,
  signal = null,
  resolveChannelRefFn = runtimeCore.resolveChannelRef,
  recordActivationFn = writeRuntimeActivationState,
  initialActivation = null,
} = {}) {
  let runtime = initialRuntime;
  let ref = runtime.ref === 'existing' ? resolveChannelRefFn(args.channel, { paths, runner }) : runtime.ref;
  let iterations = 0;
  let activation = initialActivation;
  let failedCandidateHead = null;
  let firstUpdateCheck = true;

  if (stopExisting) await stopExistingFn(paths, runtime, runner);

  while (iterations < maxIterations) {
    iterations += 1;
    const child = spawnDevBridgeDaemon(paths, runtime, spawnImpl);
    process.stdout.write(`[devbridge-supervisor] daemon-started runtime=${runtime.head}\n`);
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
        process.stderr.write(`[devbridge-supervisor] candidate-health-failed head=${activation.candidate.head}; rolling back to ${activation.previous.head}\n`);
        runtime = activation.previous;
        ref = runtime.ref;
        failedCandidateHead = activation.candidate.head;
        activation = null;
        await delayFn(restartBackoffMs);
        continue;
      }

      const doctorStatus = runDevBridgeCliFn('doctor', paths, runtime, runner);
      if (doctorStatus !== 0) {
        await recordActivation(recordActivationFn, paths, activationRecord('health-failed', paths, activation.previous, activation.candidate, {
          current: activation.previous,
          failedCandidate: activation.candidate,
          error: new Error(`candidate health doctor failed with exit ${doctorStatus}`),
        }));
        const stopStatus = runDevBridgeCliFn('stop', paths, runtime, runner);
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
      process.stdout.write(`[devbridge-supervisor] candidate-healthy head=${activation.candidate.head} previous=${activation.previous.head}\n`);
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
          const stopStatus = runDevBridgeCliFn('stop', paths, runtime, runner);
          if (stopStatus !== 0 && stopStatus !== 3) {
            process.stderr.write(`[devbridge-supervisor] operator-stop-request-exit=${stopStatus}; waiting for daemon boundary\n`);
          }
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
          process.stderr.write(`[devbridge-supervisor] update-check-error ${error.message}\n`);
          continue;
        }
        if (!remoteHead || (remoteHead === runtime.head && desiredRef === ref) || remoteHead === failedCandidateHead) continue;

        const planned = { ref: desiredRef, head: remoteHead, version: runtime.version, runtimeDir: candidateRuntimePath(paths, remoteHead), cliPath: path.join(candidateRuntimePath(paths, remoteHead), 'src', 'cli.js') };
        await recordActivation(recordActivationFn, paths, activationRecord('candidate-planned', paths, runtime, planned, { current: runtime }));
        let candidate;
        try {
          candidate = await candidatePrepareFn(args, paths, { desiredRef, desiredHead: remoteHead, previousRuntime: runtime, runner });
        } catch (error) {
          failedCandidateHead = remoteHead;
          await recordActivation(recordActivationFn, paths, activationRecord('candidate-failed', paths, runtime, planned, {
            current: runtime,
            failedCandidate: planned,
            error,
          }));
          process.stderr.write(`[devbridge-supervisor] candidate-validation-failed ${error.message}; current runtime remains ${runtime.head}\n`);
          continue;
        }

        if (signal?.aborted) {
          operatorStopPending = true;
          const stopStatus = runDevBridgeCliFn('stop', paths, runtime, runner);
          if (stopStatus !== 0 && stopStatus !== 3) process.stderr.write(`[devbridge-supervisor] operator-stop-request-exit=${stopStatus}\n`);
          continue;
        }

        pendingActivation = { previous: runtime, candidate };
        updatePending = true;
        await recordActivation(recordActivationFn, paths, activationRecord('candidate-validated', paths, runtime, candidate, { current: runtime }));
        await recordActivation(recordActivationFn, paths, activationRecord('drain-requested', paths, runtime, candidate, { current: runtime }));
        process.stdout.write(`[devbridge-supervisor] candidate-validated current=${runtime.head} next=${candidate.head}; requesting daemon drain\n`);
        const stopStatus = runDevBridgeCliFn('stop', paths, runtime, runner);
        if (stopStatus !== 0 && stopStatus !== 3) {
          process.stderr.write(`[devbridge-supervisor] stop-request-exit=${stopStatus}; waiting for daemon boundary\n`);
        }
        continue;
      }

      if (operatorStopPending) {
        process.stdout.write('[devbridge-supervisor] daemon-stopped cleanly; supervisor exiting\n');
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
        process.stdout.write('[devbridge-supervisor] daemon-stopped cleanly; supervisor exiting\n');
        return 0;
      }
      process.stderr.write(`[devbridge-supervisor] daemon-exited code=${outcome.exit.code ?? 'null'} signal=${outcome.exit.signal ?? 'none'}; restarting\n`);
      await delayFn(restartBackoffMs);
      break;
    }
  }
  return 0;
}

export async function bootstrap(argv = process.argv.slice(2), runner = defaultRunner) {
  runtimeCore.assertSupportedNode();
  const args = runtimeCore.parseBootstrapArgs(argv);
  const paths = resolveBootstrapPaths(args);
  const runtimeExists = existsSync(paths.runtime);

  let runtime = loadPersistedHealthyRuntime(paths, runner);
  if (!runtime) {
    runtime = runtimeCore.ensureRuntime(runtimeExists ? { ...args, update: false } : args, paths, runner);
    runtime = { ...runtime, runtimeDir: paths.runtime };
  }

  process.stdout.write(`[devbridge-bootstrap] channel=${args.channel} ref=${runtime.ref} version=${runtime.version} head=${runtime.head}\n`);
  if (prepareLocalConfig(paths, runtime)) {
    process.stdout.write(
      `[devbridge-bootstrap] Created safe local config: ${paths.config}\n` +
      '[devbridge-bootstrap] Review execution/controller-plan policy and enable execution only when ready.\n' +
      '[devbridge-bootstrap] Then run this same command again.\n',
    );
    return 0;
  }

  if (args.command === 'status' || args.command === 'stop') {
    return runDevBridgeCli(args.command, paths, runtime, runner);
  }

  const doctorStatus = runDevBridgeCli('doctor', paths, runtime, runner);
  if (doctorStatus !== 0 || args.command === 'doctor') return doctorStatus;

  if (args.command !== 'daemon' && args.command !== 'restart') {
    return runDevBridgeCli(args.command, paths, runtime, runner);
  }

  await stopExistingDaemon(paths, runtime, runner);
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
