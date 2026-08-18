#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SOURCE_REPOSITORY = 'https://github.com/iteathen/PATCH-POLLER.git';
const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const COMMANDS = new Set(['doctor', 'poll-once', 'run-once', 'daemon', 'status', 'stop', 'restart']);
const CHANNELS = Object.freeze({
  testing: Object.freeze(['sol/foundation-bootstrap', 'main']),
  stable: Object.freeze(['main']),
});
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 60_000;
const CHILD_RESTART_BACKOFF_MS = 5_000;
const LEGACY_TAKEOVER_GRACE_ATTEMPTS = 2;
const LEGACY_LOCK_PROTOCOL = 'patch-poller/daemon-lock-v1';

function fail(message) { throw new Error(message); }

export function assertSupportedNode(version = process.versions.node) {
  const parts = String(version).split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length < 3 || parts.some((value) => !Number.isInteger(value))) fail(`Could not parse Node.js version: ${version}`);
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parts[index] > MINIMUM_NODE[index]) return;
    if (parts[index] < MINIMUM_NODE[index]) fail('PATCH-POLLER requires Node.js 22.16.0 or newer.');
  }
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
  return value;
}

export function parseBootstrapArgs(argv) {
  const result = { command: 'daemon', channel: 'testing', home: null, config: null, update: true };
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (COMMANDS.has(value)) {
      if (commandSeen) fail('Only one PATCH-POLLER command may be supplied.');
      result.command = value;
      commandSeen = true;
      continue;
    }
    if (value === '--channel') { result.channel = takeValue(argv, index, value); index += 1; continue; }
    if (value === '--home') { result.home = takeValue(argv, index, value); index += 1; continue; }
    if (value === '--config') { result.config = takeValue(argv, index, value); index += 1; continue; }
    if (value === '--no-update') { result.update = false; continue; }
    fail(`Unknown bootstrap argument: ${value}`);
  }
  if (!Object.hasOwn(CHANNELS, result.channel)) fail(`Unknown PATCH-POLLER channel: ${result.channel}`);
  return result;
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return value;
}

export function resolveBootstrapPaths(args, environment = process.env) {
  const configuredHome = args.home ?? environment.PATCH_POLLER_HOME;
  const home = path.resolve(expandHome(configuredHome || path.join(homedir(), '.patch-poller')));
  const runtime = path.join(home, 'runtime');
  const config = path.resolve(expandHome(args.config || path.join(home, 'config.json')));
  return { home, runtime, config, gitHome: path.join(home, 'bootstrap-git-home'), hooks: path.join(home, 'bootstrap-empty-hooks') };
}

const SCRUBBED_GIT_ENVIRONMENT = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ASKPASS', 'GIT_CONFIG', 'GIT_CONFIG_COUNT',
  'GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_WORK_TREE',
  'SSH_ASKPASS', 'SSH_AUTH_SOCK',
]);

export function managedGitEnvironment(paths, base = process.env, platform = process.platform) {
  const environment = { ...base };
  for (const name of SCRUBBED_GIT_ENVIRONMENT) delete environment[name];
  environment.HOME = paths.gitHome;
  environment.USERPROFILE = paths.gitHome;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = platform === 'win32' ? 'NUL' : '/dev/null';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GCM_INTERACTIVE = 'Never';
  return environment;
}

function gitPrefix(paths) {
  return ['-c', `core.hooksPath=${paths.hooks}`, '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never'];
}

function defaultRunner(executable, args, options) {
  return spawnSync(executable, args, { ...options, shell: false, encoding: options.stdio === 'inherit' ? undefined : 'utf8', maxBuffer: CAPTURE_LIMIT });
}

function formatFailure(executable, args, result) {
  const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
  const suffix = detail ? `: ${detail.slice(0, 2000)}` : '';
  return `${executable} ${args.join(' ')} failed (exit ${result.status ?? 'spawn-error'})${suffix}`;
}

export function runGit(args, { paths, cwd = undefined, runner = defaultRunner, allowFailure = false } = {}) {
  const environment = managedGitEnvironment(paths);
  const fullArgs = [...gitPrefix(paths), ...args];
  const result = runner('git', fullArgs, { cwd, env: environment, timeout: GIT_TIMEOUT_MS, shell: false, windowsHide: true });
  if (result.error || result.status !== 0) {
    if (allowFailure) return result;
    fail(formatFailure('git', fullArgs, result));
  }
  return result;
}

function normalizedRemote(value) { return String(value || '').trim().replace(/\/$/u, '').replace(/\.git$/u, '').toLowerCase(); }

function verifyRuntimeRepository(paths, runner) {
  const gitDirectory = path.join(paths.runtime, '.git');
  if (!existsSync(gitDirectory)) fail(`Managed runtime is not a Git checkout: ${paths.runtime}`);
  const remote = runGit(['remote', 'get-url', 'origin'], { paths, cwd: paths.runtime, runner }).stdout;
  if (normalizedRemote(remote) !== normalizedRemote(SOURCE_REPOSITORY)) fail('Managed runtime origin does not match the trusted PATCH-POLLER repository.');
  const dirty = runGit(['status', '--porcelain'], { paths, cwd: paths.runtime, runner }).stdout.trim();
  if (dirty) fail('Managed PATCH-POLLER runtime contains local changes; refusing to overwrite it automatically.');
}

export function remoteBranchHead(ref, { paths, runner = defaultRunner } = {}) {
  const result = runGit(['ls-remote', '--exit-code', '--heads', SOURCE_REPOSITORY, `refs/heads/${ref}`], { paths, runner, allowFailure: true });
  if (result.error || result.status !== 0) return null;
  const line = String(result.stdout || '').trim().split(/\r?\n/u)[0] ?? '';
  const [sha] = line.split(/\s+/u);
  return /^[0-9a-f]{40}$/iu.test(sha ?? '') ? sha.toLowerCase() : null;
}

function remoteBranchExists(ref, paths, runner) { return remoteBranchHead(ref, { paths, runner }) != null; }

export function resolveChannelRef(channel, { paths, runner = defaultRunner } = {}) {
  for (const ref of CHANNELS[channel]) if (remoteBranchExists(ref, paths, runner)) return ref;
  fail(`No trusted branch is available for PATCH-POLLER channel ${channel}.`);
}

function validateRuntimeShape(runtime) {
  const packagePath = path.join(runtime, 'package.json');
  const cliPath = path.join(runtime, 'src', 'cli.js');
  if (!existsSync(packagePath) || !statSync(packagePath).isFile() || !existsSync(cliPath) || !statSync(cliPath).isFile()) fail('Fetched PATCH-POLLER runtime does not contain the expected package/CLI shape.');
  let manifest;
  try { manifest = JSON.parse(readFileSync(packagePath, 'utf8')); } catch { fail('Fetched PATCH-POLLER package.json is not valid JSON.'); }
  if (manifest?.name !== 'patch-poller' || typeof manifest.version !== 'string') fail('Fetched runtime does not identify itself as PATCH-POLLER.');
  return { cliPath, version: manifest.version };
}

export function ensureRuntime(args, paths, runner = defaultRunner) {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.gitHome, { recursive: true });
  mkdirSync(paths.hooks, { recursive: true });
  if (!args.update) {
    if (!existsSync(paths.runtime)) fail('--no-update requires an existing managed runtime.');
    verifyRuntimeRepository(paths, runner);
    const shape = validateRuntimeShape(paths.runtime);
    const head = runGit(['rev-parse', 'HEAD'], { paths, cwd: paths.runtime, runner }).stdout.trim();
    return { ...shape, ref: 'existing', head };
  }
  const ref = resolveChannelRef(args.channel, { paths, runner });
  if (!existsSync(paths.runtime)) {
    runGit(['clone', '--no-tags', '--depth', '1', '--single-branch', '--branch', ref, SOURCE_REPOSITORY, paths.runtime], { paths, runner });
  } else {
    verifyRuntimeRepository(paths, runner);
    runGit(['fetch', '--no-tags', '--depth', '1', '--prune', 'origin', `refs/heads/${ref}`], { paths, cwd: paths.runtime, runner });
    runGit(['checkout', '--detach', '--force', 'FETCH_HEAD'], { paths, cwd: paths.runtime, runner });
  }
  verifyRuntimeRepository(paths, runner);
  const shape = validateRuntimeShape(paths.runtime);
  const head = runGit(['rev-parse', 'HEAD'], { paths, cwd: paths.runtime, runner }).stdout.trim();
  return { ...shape, ref, head };
}

export function prepareLocalConfig(paths) {
  if (existsSync(paths.config)) return false;
  const example = path.join(paths.runtime, 'config', 'patch-poller.example.json');
  if (!existsSync(example)) fail('Fetched runtime is missing the safe example configuration.');
  mkdirSync(path.dirname(paths.config), { recursive: true });
  copyFileSync(example, paths.config, constants.COPYFILE_EXCL);
  return true;
}

export function runPollerCli(command, paths, runtime, runner = defaultRunner) {
  const result = runner(process.execPath, [runtime.cliPath, command, '--config', paths.config], {
    cwd: paths.runtime, env: process.env, stdio: 'inherit', shell: false, windowsHide: false,
  });
  if (result.error) fail(`Could not start PATCH-POLLER ${command}: ${result.error.message}`);
  return result.status ?? 1;
}

export function runPollerCliCaptured(command, paths, runtime, runner = defaultRunner) {
  const result = runner(process.execPath, [runtime.cliPath, command, '--config', paths.config], {
    cwd: paths.runtime, env: process.env, stdio: 'pipe', shell: false, windowsHide: true,
  });
  if (result.error) fail(`Could not start PATCH-POLLER ${command}: ${result.error.message}`);
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function daemonStateDirectory(paths) {
  let raw;
  try { raw = JSON.parse(readFileSync(paths.config, 'utf8')); }
  catch { fail(`Cannot parse local PATCH-POLLER config while adopting legacy daemon: ${paths.config}`); }
  const configured = raw?.state?.directory ?? '~/.patch-poller/state';
  if (typeof configured !== 'string' || configured.trim() === '') fail('Local PATCH-POLLER state.directory is invalid during legacy takeover.');
  const expanded = expandHome(configured);
  if (!path.isAbsolute(expanded)) fail('Local PATCH-POLLER state.directory must be absolute or start with ~/.');
  return path.normalize(expanded);
}

function legacyLockPath(paths) { return path.join(daemonStateDirectory(paths), 'daemon.lock'); }

function readLegacyLock(filePath) {
  if (!existsSync(filePath)) return null;
  let value;
  try { value = JSON.parse(readFileSync(filePath, 'utf8')); }
  catch { fail(`Legacy PATCH-POLLER daemon lock is malformed at ${filePath}`); }
  if (value?.protocol !== LEGACY_LOCK_PROTOCOL || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value.token)) {
    fail(`Legacy PATCH-POLLER daemon lock is malformed at ${filePath}`);
  }
  return value;
}

export function validateLegacyDaemonIdentity(record, { paths, runtime }) {
  if (!record || Number(record.processId) <= 0) fail('Legacy daemon process identity is missing.');
  const expectedCli = path.resolve(runtime.cliPath).toLowerCase();
  const expectedConfig = path.resolve(paths.config).toLowerCase();
  const commandLine = String(record.commandLine ?? '').toLowerCase();
  if (String(record.name ?? '').toLowerCase() !== 'node.exe' || !commandLine.includes(expectedCli) || !commandLine.includes(expectedConfig) || !/\bdaemon\b/iu.test(commandLine)) {
    fail('Legacy daemon PID does not identify the expected PATCH-POLLER daemon; refusing forced takeover.');
  }
  return true;
}

function windowsLegacyProcess(pid, runner) {
  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 4 }; [pscustomobject]@{processId=[int]$p.ProcessId;name=[string]$p.Name;commandLine=[string]$p.CommandLine} | ConvertTo-Json -Compress`;
  const result = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: process.env,
    stdio: 'pipe',
    timeout: 15_000,
    shell: false,
    windowsHide: true,
  });
  if (result.status === 4) return null;
  if (result.error || result.status !== 0) fail(formatFailure('powershell.exe', ['<legacy-daemon-identity-check>'], result));
  try { return JSON.parse(String(result.stdout || '')); }
  catch { fail('Could not parse Windows legacy daemon process identity.'); }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function cleanupExactLegacyLock(filePath, original) {
  const current = readLegacyLock(filePath);
  if (!current) return;
  if (current.pid !== original.pid || current.token !== original.token) fail('Legacy daemon lock ownership changed during takeover; refusing cleanup.');
  unlinkSync(filePath);
  const stopPath = `${filePath}.stop-${original.token}`;
  if (existsSync(stopPath)) unlinkSync(stopPath);
}

export async function forceTerminateLegacyDaemon(paths, runtime, runner = defaultRunner, { platform = process.platform, delayFn = delay } = {}) {
  const filePath = legacyLockPath(paths);
  const lock = readLegacyLock(filePath);
  if (!lock) return { forced: false, alreadyStopped: true };
  if (platform !== 'win32') fail('Legacy forced takeover is currently implemented only for Windows; refusing an unverifiable PID termination.');

  const identity = windowsLegacyProcess(lock.pid, runner);
  if (identity) {
    validateLegacyDaemonIdentity(identity, { paths, runtime });
    process.stdout.write(`[patch-poller-supervisor] verified legacy daemon pid=${lock.pid}; forcing one-time takeover after cooperative stop timeout\n`);
    const killed = runner('taskkill.exe', ['/PID', String(lock.pid), '/T', '/F'], {
      env: process.env,
      stdio: 'pipe',
      timeout: 15_000,
      shell: false,
      windowsHide: true,
    });
    if ((killed.error || killed.status !== 0) && processExists(lock.pid)) fail(formatFailure('taskkill.exe', ['/PID', String(lock.pid), '/T', '/F'], killed));
  }

  const deadline = Date.now() + 10_000;
  while (processExists(lock.pid) && Date.now() < deadline) await delayFn(100);
  if (processExists(lock.pid)) fail(`Verified legacy PATCH-POLLER daemon pid=${lock.pid} did not terminate.`);
  cleanupExactLegacyLock(filePath, lock);
  return { forced: true, pid: lock.pid };
}

export function spawnPollerDaemon(paths, runtime, spawnImpl = spawn) {
  return spawnImpl(process.execPath, [runtime.cliPath, 'daemon', '--config', paths.config], {
    cwd: paths.runtime,
    env: process.env,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function updateCheckDelay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function decideSupervisorAction({ childExitCode, updatePending, operatorStopPending = false }) {
  if (operatorStopPending) return 'stop';
  if (updatePending) return 'update';
  if (childExitCode === 0) return 'stop';
  return 'restart';
}

export async function stopExistingDaemon(paths, runtime, runner = defaultRunner, {
  maxGraceAttempts = LEGACY_TAKEOVER_GRACE_ATTEMPTS,
  stopCommandFn = () => runPollerCliCaptured('stop', paths, runtime, runner),
  forceLegacyStopFn = () => forceTerminateLegacyDaemon(paths, runtime, runner),
  delayFn = delay,
} = {}) {
  for (let attempt = 1; attempt <= maxGraceAttempts; attempt += 1) {
    const result = stopCommandFn();
    if (result.status === 0) return { forced: false };
    if (result.status !== 3) {
      const detail = (result.stderr || result.stdout).trim();
      fail(`Could not stop existing PATCH-POLLER daemon (exit ${result.status})${detail ? `: ${detail.slice(0, 2000)}` : ''}`);
    }
    if (attempt < maxGraceAttempts) {
      process.stdout.write(`[patch-poller-supervisor] existing daemon is finishing an active cycle; cooperative stop attempt ${attempt}/${maxGraceAttempts}\n`);
      await delayFn(1000);
    }
  }
  return forceLegacyStopFn();
}

export async function superviseDaemon(args, paths, initialRuntime, {
  runner = defaultRunner,
  spawnImpl = spawn,
  updateIntervalMs = UPDATE_CHECK_INTERVAL_MS,
  restartBackoffMs = CHILD_RESTART_BACKOFF_MS,
  maxIterations = Number.POSITIVE_INFINITY,
  takeover = true,
  remoteHeadFn = remoteBranchHead,
  ensureRuntimeFn = ensureRuntime,
  runPollerCliFn = runPollerCli,
  stopExistingFn = stopExistingDaemon,
  updateCheckDelayFn = updateCheckDelay,
  delayFn = delay,
  signal = null,
  resolveChannelRefFn = resolveChannelRef,
} = {}) {
  let runtime = initialRuntime;
  let ref = runtime.ref === 'existing' ? resolveChannelRefFn(args.channel, { paths, runner }) : runtime.ref;
  let iterations = 0;

  if (takeover) await stopExistingFn(paths, runtime, runner);

  while (iterations < maxIterations) {
    iterations += 1;
    const child = spawnPollerDaemon(paths, runtime, spawnImpl);
    process.stdout.write(`[patch-poller-supervisor] daemon-started runtime=${runtime.head}\n`);
    const exitPromise = childExit(child);
    let updatePending = false;
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
        waits.push(updateCheckDelayFn(updateIntervalMs).then(() => ({ type: 'update-check' })));
      }
      const outcome = await Promise.race(waits);

      if (outcome.type === 'operator-stop') {
        if (!operatorStopPending) {
          operatorStopPending = true;
          const stopStatus = runPollerCliFn('stop', paths, runtime, runner);
          if (stopStatus !== 0 && stopStatus !== 3) {
            process.stderr.write(`[patch-poller-supervisor] operator-stop-request-exit=${stopStatus}; waiting for daemon boundary\n`);
          }
        }
        continue;
      }

      if (outcome.type === 'update-check') {
        if (!args.update || updatePending) continue;
        let remoteHead = null;
        let desiredRef = ref;
        try {
          desiredRef = resolveChannelRefFn(args.channel, { paths, runner });
          remoteHead = remoteHeadFn(desiredRef, { paths, runner });
        }
        catch (error) {
          process.stderr.write(`[patch-poller-supervisor] update-check-error ${error.message}\n`);
          continue;
        }
        if (!remoteHead || (remoteHead === runtime.head && desiredRef === ref)) continue;
        updatePending = true;
        process.stdout.write(`[patch-poller-supervisor] update-detected current=${ref}@${runtime.head} next=${desiredRef}@${remoteHead}\n`);
        const stopStatus = runPollerCliFn('stop', paths, runtime, runner);
        if (stopStatus !== 0 && stopStatus !== 3) {
          process.stderr.write(`[patch-poller-supervisor] stop-request-exit=${stopStatus}; waiting for daemon boundary\n`);
        }
        continue;
      }

      const action = decideSupervisorAction({ childExitCode: outcome.exit.code, updatePending, operatorStopPending });
      if (action === 'stop') {
        process.stdout.write('[patch-poller-supervisor] daemon-stopped cleanly; supervisor exiting\n');
        return 0;
      }
      if (action === 'restart') {
        process.stderr.write(`[patch-poller-supervisor] daemon-exited code=${outcome.exit.code ?? 'null'} signal=${outcome.exit.signal ?? 'none'}; restarting\n`);
        await delayFn(restartBackoffMs);
        break;
      }

      const previous = runtime;
      try {
        runtime = ensureRuntimeFn(args, paths, runner);
        const doctorStatus = runPollerCliFn('doctor', paths, runtime, runner);
        if (doctorStatus !== 0) throw new Error(`updated runtime doctor failed with exit ${doctorStatus}`);
        ref = runtime.ref === 'existing' ? ref : runtime.ref;
        process.stdout.write(`[patch-poller-supervisor] update-applied previous=${previous.head} current=${runtime.head}\n`);
      } catch (error) {
        process.stderr.write(`[patch-poller-supervisor] update-failed ${error.message}; attempting rollback to ${previous.head}\n`);
        try {
          runGit(['checkout', '--detach', '--force', previous.head], { paths, cwd: paths.runtime, runner });
          verifyRuntimeRepository(paths, runner);
          runtime = { ...validateRuntimeShape(paths.runtime), ref, head: previous.head };
          const doctorStatus = runPollerCliFn('doctor', paths, runtime, runner);
          if (doctorStatus !== 0) throw new Error(`rollback doctor failed with exit ${doctorStatus}`);
          process.stderr.write(`[patch-poller-supervisor] rollback-applied head=${runtime.head}\n`);
        } catch (rollbackError) {
          throw new Error(`runtime update failed (${error.message}) and rollback failed (${rollbackError.message})`);
        }
      }
      break;
    }
  }
  return 0;
}

export async function bootstrap(argv = process.argv.slice(2), runner = defaultRunner) {
  assertSupportedNode();
  const args = parseBootstrapArgs(argv);
  const paths = resolveBootstrapPaths(args);
  const runtimeExists = existsSync(paths.runtime);

  if (args.command === 'daemon' || args.command === 'restart') {
    let runtime = null;
    if (runtimeExists) {
      const existing = ensureRuntime({ ...args, update: false }, paths, runner);
      await stopExistingDaemon(paths, existing, runner);
      runtime = args.update ? ensureRuntime({ ...args, command: 'daemon' }, paths, runner) : existing;
    } else {
      runtime = ensureRuntime({ ...args, command: 'daemon' }, paths, runner);
    }

    process.stdout.write(`[patch-poller-bootstrap] channel=${args.channel} ref=${runtime.ref} version=${runtime.version} head=${runtime.head}\n`);
    if (prepareLocalConfig(paths)) {
      process.stdout.write(
        `[patch-poller-bootstrap] Created safe local config: ${paths.config}\n` +
        '[patch-poller-bootstrap] Review the tool profile and set execution.enabled only when ready.\n' +
        '[patch-poller-bootstrap] Then run this same command again.\n',
      );
      return 0;
    }
    const doctorStatus = runPollerCli('doctor', paths, runtime, runner);
    if (doctorStatus !== 0) return doctorStatus;

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

  // One-shot inspection/control commands use the exact currently installed
  // runtime and never mutate files beneath an active daemon.
  const runtime = ensureRuntime(
    runtimeExists ? { ...args, update: false } : args,
    paths,
    runner,
  );
  process.stdout.write(`[patch-poller-bootstrap] channel=${args.channel} ref=${runtime.ref} version=${runtime.version} head=${runtime.head}\n`);

  if (prepareLocalConfig(paths)) {
    process.stdout.write(
      `[patch-poller-bootstrap] Created safe local config: ${paths.config}\n` +
      '[patch-poller-bootstrap] Review the tool profile and set execution.enabled only when ready.\n' +
      '[patch-poller-bootstrap] Then run this same command again.\n',
    );
    return 0;
  }

  if (args.command === 'status' || args.command === 'stop') {
    return runPollerCli(args.command, paths, runtime, runner);
  }

  const doctorStatus = runPollerCli('doctor', paths, runtime, runner);
  if (doctorStatus !== 0 || args.command === 'doctor') return doctorStatus;
  return runPollerCli(args.command, paths, runtime, runner);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  bootstrap().then((status) => { process.exitCode = status; }).catch((error) => {
    process.stderr.write(`[patch-poller-bootstrap] ${error.message}\n`);
    process.exitCode = 1;
  });
}
