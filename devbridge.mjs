#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SOURCE_REPOSITORY = 'https://github.com/iteathen/DevBridge.git';
export const STAGE0_PROTOCOL = 1;
const ACTIVATION_PROTOCOL = 'devbridge/runtime-activation-v1';
const MIGRATION_PROTOCOL = 'devbridge/stage0-migration-v1';
const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const TERMINAL_ACTIVATION_STATES = new Set(['healthy', 'rolled-back', 'candidate-failed']);
const STAGE0_COMMANDS = new Set(['bootstrap-status', 'migrate-legacy-runtime']);
const RUNTIME_COMMANDS = new Set(['doctor', 'poll-once', 'run-once', 'daemon', 'status', 'stop', 'restart']);
const VALUE_FLAGS = new Set([
  '--home', '--config', '--channel', '--release-mode', '--release-manifest', '--release-public-key',
]);
const SCRUBBED_GIT_ENVIRONMENT = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ASKPASS', 'GIT_CONFIG', 'GIT_CONFIG_COUNT',
  'GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_WORK_TREE',
  'SSH_ASKPASS', 'SSH_AUTH_SOCK',
]);

function fail(message) { throw new Error(message); }
function exactHead(value) { return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value) ? value.toLowerCase() : null; }
function sha256(value) { return createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function now() { return new Date().toISOString(); }

export function assertSupportedNode(version = process.versions.node) {
  const parts = String(version).split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length < 3 || parts.some((value) => !Number.isInteger(value))) fail(`Could not parse Node.js version: ${version}`);
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parts[index] > MINIMUM_NODE[index]) return;
    if (parts[index] < MINIMUM_NODE[index]) fail('DevBridge requires Node.js 22.16.0 or newer.');
  }
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
  return value;
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return value;
}

export function parseStage0Args(argv) {
  let home = null;
  let noUpdate = false;
  let command = null;
  let expectedRuntimeHead = null;
  let validatedCandidateHead = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (STAGE0_COMMANDS.has(value)) {
      if (command !== null) fail('Only one Stage 0 command may be supplied.');
      command = value;
    } else if (value === '--home') {
      if (home !== null) fail('Only one --home value may be supplied.');
      home = takeValue(argv, index, value);
      index += 1;
    } else if (value === '--no-update') {
      noUpdate = true;
    } else if (value === '--expected-runtime-head') {
      expectedRuntimeHead = exactHead(takeValue(argv, index, value));
      if (!expectedRuntimeHead) fail('--expected-runtime-head requires an exact 40-hex Git head.');
      index += 1;
    } else if (value === '--validated-candidate-head') {
      validatedCandidateHead = exactHead(takeValue(argv, index, value));
      if (!validatedCandidateHead) fail('--validated-candidate-head requires an exact 40-hex Git head.');
      index += 1;
    } else if (VALUE_FLAGS.has(value)) {
      takeValue(argv, index, value);
      index += 1;
    }
  }
  return { home, noUpdate, command, expectedRuntimeHead, validatedCandidateHead };
}

export function resolveStage0Paths(args, environment = process.env) {
  const configuredHome = args.home ?? environment.DEVBRIDGE_HOME;
  const home = path.resolve(expandHome(configuredHome || path.join(homedir(), '.devbridge')));
  return {
    home,
    runtime: path.join(home, 'runtime'),
    activationStateFile: path.join(home, 'runtime-activation.json'),
    migrationStateFile: path.join(home, 'stage0-migration.json'),
    legacyRuntimeRoot: path.join(home, 'legacy-runtime-migrations'),
    gitHome: path.join(home, 'bootstrap-git-home'),
    hooks: path.join(home, 'bootstrap-empty-hooks'),
  };
}

export function stage0InstallationTag(home, platform = process.platform) {
  const resolved = path.resolve(String(home));
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  let canonical = realpathSync.native(resolved);
  if (platform === 'win32') canonical = canonical.toLowerCase();
  const identity = sha256(`devbridge/installation-v1\0${canonical}`);
  return `DB-${identity.slice(0, 12).toUpperCase()}`;
}

export function managedGitEnvironment(paths, base = process.env, platform = process.platform) {
  const environment = { ...base };
  for (const name of SCRUBBED_GIT_ENVIRONMENT) delete environment[name];
  if (platform === 'win32') {
    const pathValue = base.Path ?? base.PATH ?? base.path;
    for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key];
    if (pathValue != null) environment.Path = pathValue;
  }
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
  return spawnSync(executable, args, {
    ...options,
    shell: false,
    encoding: 'utf8',
    maxBuffer: CAPTURE_LIMIT,
  });
}

function formatFailure(executable, args, result) {
  const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
  return `${executable} ${args.join(' ')} failed (exit ${result.status ?? 'spawn-error'})${detail ? `: ${detail.slice(0, 2000)}` : ''}`;
}

export function runGit(args, { paths, cwd = undefined, runner = defaultRunner, allowFailure = false } = {}) {
  const fullArgs = [...gitPrefix(paths), ...args];
  const result = runner('git', fullArgs, {
    cwd,
    env: managedGitEnvironment(paths),
    timeout: GIT_TIMEOUT_MS,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return result;
    fail(formatFailure('git', fullArgs, result));
  }
  return result;
}

function normalizedRemote(value) {
  return String(value || '').trim().replace(/\/$/u, '').replace(/\.git$/u, '').toLowerCase();
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function runtimeMinimumStage0Protocol(manifest) {
  const value = manifest?.devbridge?.bootstrap?.minimumStage0Protocol ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) fail('Managed runtime declares an invalid Stage 0 compatibility requirement.');
  return value;
}

function validateRuntimeRepository(paths, runner, runtimeDir = paths.runtime) {
  const gitDirectory = path.join(runtimeDir, '.git');
  if (!existsSync(gitDirectory)) fail(`Managed runtime is not a Git checkout: ${runtimeDir}`);
  const remote = runGit(['remote', 'get-url', 'origin'], { paths, cwd: runtimeDir, runner }).stdout;
  if (normalizedRemote(remote) !== normalizedRemote(SOURCE_REPOSITORY)) fail('Managed runtime origin does not match the trusted DevBridge repository.');
  const dirty = runGit(['status', '--porcelain'], { paths, cwd: runtimeDir, runner }).stdout.trim();
  if (dirty) fail('Managed DevBridge runtime contains local changes; refusing to execute it.');
}

function validateRuntimeShape(runtime) {
  const packagePath = path.join(runtime, 'package.json');
  const secureBootstrapPath = path.join(runtime, 'src', 'bootstrap', 'secure-bootstrap.mjs');
  if (!existsSync(packagePath) || !statSync(packagePath).isFile() || !existsSync(secureBootstrapPath) || !statSync(secureBootstrapPath).isFile()) {
    fail('Fetched DevBridge runtime does not contain the expected package/bootstrap shape.');
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(packagePath, 'utf8')); }
  catch { fail('Fetched DevBridge package.json is not valid JSON.'); }
  if (manifest?.name !== 'devbridge' || typeof manifest.version !== 'string') fail('Fetched runtime does not identify itself as DevBridge.');
  const minimumStage0Protocol = runtimeMinimumStage0Protocol(manifest);
  if (minimumStage0Protocol > STAGE0_PROTOCOL) {
    fail(`Managed runtime requires Stage 0 protocol ${minimumStage0Protocol}, but this launcher supports ${STAGE0_PROTOCOL}; refresh the local Stage 0 launcher before starting it.`);
  }
  return { secureBootstrapPath, version: manifest.version, minimumStage0Protocol };
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, filePath);
}

export function readStage0ActivationState(paths) {
  if (!existsSync(paths.activationStateFile)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(paths.activationStateFile, 'utf8')); }
  catch { fail('Runtime activation state is malformed; refusing to guess the accepted runtime.'); }
  if (parsed?.protocol !== ACTIVATION_PROTOCOL || typeof parsed.state !== 'string') {
    fail('Runtime activation state uses an unsupported protocol; refusing to guess the accepted runtime.');
  }
  return parsed;
}

function readStage0MigrationState(paths) {
  if (!existsSync(paths.migrationStateFile)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(paths.migrationStateFile, 'utf8')); }
  catch { fail('Stage 0 migration state is malformed; refusing to guess recovery state.'); }
  const previousHead = exactHead(parsed?.previousHead);
  const nextHead = exactHead(parsed?.nextHead);
  if (parsed?.protocol !== MIGRATION_PROTOCOL || parsed.state !== 'transitioning' ||
      !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || !previousHead || !nextHead ||
      typeof parsed.startedAt !== 'string') {
    fail('Stage 0 migration state is invalid; refusing to guess recovery state.');
  }
  return { ...parsed, previousHead, nextHead };
}

function migrationBackup(paths, head) {
  return {
    root: path.join(paths.legacyRuntimeRoot, head),
    runtime: path.join(paths.legacyRuntimeRoot, head, 'runtime'),
    activation: path.join(paths.legacyRuntimeRoot, head, 'runtime-activation.json'),
  };
}

function restoreLegacyRuntime(paths, backup) {
  if (existsSync(paths.runtime)) rmSync(paths.runtime, { recursive: true, force: true });
  if (existsSync(backup.runtime)) renameSync(backup.runtime, paths.runtime);
  if (existsSync(paths.activationStateFile)) rmSync(paths.activationStateFile, { force: true });
  if (existsSync(backup.activation)) renameSync(backup.activation, paths.activationStateFile);
}

export function reconcileStage0Migration(paths, { processAliveFn = processIsAlive } = {}) {
  const record = readStage0MigrationState(paths);
  if (!record) return null;
  if (record.pid !== process.pid && processAliveFn(record.pid)) {
    fail(`Stage 0 migration is already in progress for ${record.previousHead.slice(0, 12)} -> ${record.nextHead.slice(0, 12)}.`);
  }
  const backup = migrationBackup(paths, record.previousHead);
  if (existsSync(backup.root) && !existsSync(backup.runtime)) {
    fail('Stage 0 migration backup is incomplete; refusing automatic recovery.');
  }
  if (existsSync(backup.runtime)) restoreLegacyRuntime(paths, backup);
  else if (!existsSync(paths.runtime)) fail('Interrupted Stage 0 migration has neither an accepted runtime nor a recoverable backup.');
  rmSync(paths.migrationStateFile, { force: true });
  return Object.freeze({ state: 'rolled-back', previousHead: record.previousHead, abandonedHead: record.nextHead });
}

function runtimeFromDirectory(paths, runtimeDir, runner, expectedHead = null) {
  const resolved = path.resolve(runtimeDir);
  if (!isWithin(paths.home, resolved)) fail('Accepted runtime identity escapes the installation home.');
  validateRuntimeRepository(paths, runner, resolved);
  const shape = validateRuntimeShape(resolved);
  const head = exactHead(String(runGit(['rev-parse', 'HEAD'], { paths, cwd: resolved, runner }).stdout || '').trim());
  if (!head) fail('Managed runtime HEAD is not an exact Git commit.');
  if (expectedHead && head !== expectedHead) fail('Managed runtime HEAD does not match durable activation state.');
  return { ...shape, head, runtimeDir: resolved };
}

export function selectStage0Runtime(paths, runner = defaultRunner) {
  const activation = readStage0ActivationState(paths);
  if (activation) {
    if (!TERMINAL_ACTIVATION_STATES.has(activation.state)) {
      fail(`Runtime activation is incomplete (${activation.state}); refusing to fall back to an older checkout. Inspect bootstrap-status and reconcile the interrupted activation before starting DevBridge.`);
    }
    const current = activation.current;
    const head = exactHead(current?.head);
    if (!current?.runtimeDir || !head) fail('Runtime activation state does not identify one exact accepted runtime.');
    return { runtime: runtimeFromDirectory(paths, current.runtimeDir, runner, head), activationState: activation.state };
  }

  if (!existsSync(paths.runtime)) fail('Managed DevBridge runtime is absent.');
  return { runtime: runtimeFromDirectory(paths, paths.runtime, runner), activationState: 'untracked' };
}

export function ensureStage0Runtime(args, paths, runner = defaultRunner) {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.gitHome, { recursive: true });
  mkdirSync(paths.hooks, { recursive: true });
  if (!existsSync(paths.runtime) && !existsSync(paths.activationStateFile)) {
    if (args.noUpdate) fail('--no-update requires an existing managed DevBridge runtime.');
    runGit(['clone', '--no-tags', '--depth', '1', '--single-branch', '--branch', 'main', SOURCE_REPOSITORY, paths.runtime], { paths, runner });
  }
  return selectStage0Runtime(paths, runner);
}

function forwardedRuntimeArgs(argv, command = null, forceNoUpdate = false) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (STAGE0_COMMANDS.has(value)) continue;
    if (value === '--expected-runtime-head' || value === '--validated-candidate-head') { index += 1; continue; }
    if (VALUE_FLAGS.has(value)) {
      result.push(value, argv[index + 1]);
      index += 1;
      continue;
    }
    if (RUNTIME_COMMANDS.has(value)) {
      if (command === null) result.push(value);
      continue;
    }
    result.push(value);
  }
  if (command !== null) result.unshift(command);
  if (forceNoUpdate && !result.includes('--no-update')) result.push('--no-update');
  return result;
}

function remoteMainHead(paths, runner) {
  const result = runGit(['ls-remote', '--exit-code', '--heads', SOURCE_REPOSITORY, 'refs/heads/main'], { paths, runner });
  const head = exactHead(String(result.stdout || '').trim().split(/\s+/u)[0]);
  if (!head) fail('Could not resolve one exact trusted main head for legacy migration.');
  return head;
}

async function importBootstrap(runtime, importModuleFn) {
  const module = await importModuleFn(pathToFileURL(runtime.secureBootstrapPath).href);
  if (typeof module.bootstrap !== 'function') fail('Managed DevBridge runtime does not export the secure bootstrap entrypoint.');
  return module;
}

function beginMigration(paths, previousHead, nextHead) {
  if (existsSync(paths.migrationStateFile)) fail('Stage 0 migration state already exists; reconcile it before starting another migration.');
  writeJsonAtomic(paths.migrationStateFile, {
    protocol: MIGRATION_PROTOCOL,
    state: 'transitioning',
    pid: process.pid,
    previousHead,
    nextHead,
    startedAt: now(),
  });
}

async function migrateLegacyRuntime(argv, args, paths, selection, runner, importModuleFn, installationTag) {
  if (args.noUpdate) fail('migrate-legacy-runtime cannot be combined with --no-update.');
  if (argv.includes('--release-mode') && argv[argv.indexOf('--release-mode') + 1] === 'production') {
    fail('migrate-legacy-runtime is a development/testing compatibility transition; production recovery must use the signed release path.');
  }
  if (!args.expectedRuntimeHead || !args.validatedCandidateHead) {
    fail('migrate-legacy-runtime requires --expected-runtime-head and --validated-candidate-head exact Git heads.');
  }
  const current = selection.runtime;
  if (current.minimumStage0Protocol !== 0) fail('migrate-legacy-runtime is only available for pre-compatibility runtimes.');
  if (path.resolve(current.runtimeDir) !== path.resolve(paths.runtime)) fail('Legacy migration requires the accepted runtime to be the canonical legacy checkout.');
  if (current.head !== args.expectedRuntimeHead) fail('Accepted runtime changed since the operator authorized legacy migration.');
  const desiredHead = remoteMainHead(paths, runner);
  if (desiredHead !== args.validatedCandidateHead) fail('Trusted main changed after the operator validated the candidate; revalidate the exact current head before migration.');

  beginMigration(paths, current.head, desiredHead);
  const currentModule = await importBootstrap(current, importModuleFn);
  const stopStatus = await currentModule.bootstrap(forwardedRuntimeArgs(argv, 'stop', true), undefined, { stage0Protocol: STAGE0_PROTOCOL });
  if (stopStatus !== 0) {
    rmSync(paths.migrationStateFile, { force: true });
    fail(`Legacy runtime did not stop cooperatively (exit ${stopStatus}); refusing migration.`);
  }

  const backup = migrationBackup(paths, current.head);
  if (existsSync(backup.root)) {
    rmSync(paths.migrationStateFile, { force: true });
    fail('A legacy migration backup already exists for the accepted runtime; reconcile it before retrying.');
  }
  mkdirSync(backup.root, { recursive: true });
  renameSync(paths.runtime, backup.runtime);
  if (existsSync(paths.activationStateFile)) renameSync(paths.activationStateFile, backup.activation);

  try {
    runGit(['clone', '--no-tags', '--depth', '1', '--single-branch', '--branch', 'main', SOURCE_REPOSITORY, paths.runtime], { paths, runner });
    const migrated = runtimeFromDirectory(paths, paths.runtime, runner, desiredHead);
    if (migrated.minimumStage0Protocol < 1) fail('Migrated runtime does not implement the Stage 0 compatibility contract.');
    const nextModule = await importBootstrap(migrated, importModuleFn);
    const doctorStatus = await nextModule.bootstrap(forwardedRuntimeArgs(argv, 'doctor', true), undefined, { stage0Protocol: STAGE0_PROTOCOL });
    if (doctorStatus !== 0) fail(`Migrated runtime doctor failed with exit ${doctorStatus}.`);
    rmSync(paths.migrationStateFile, { force: true });
    process.stdout.write(`[devbridge-stage0 ${installationTag}] legacy-migration previous=${current.head} current=${migrated.head} protocol=${STAGE0_PROTOCOL}\n`);
    const status = await nextModule.bootstrap(forwardedRuntimeArgs(argv, 'daemon', true), undefined, { stage0Protocol: STAGE0_PROTOCOL });
    if (status !== 0) restoreLegacyRuntime(paths, backup);
    return status;
  } catch (error) {
    restoreLegacyRuntime(paths, backup);
    rmSync(paths.migrationStateFile, { force: true });
    throw error;
  }
}

function printBootstrapStatus(selection, installationTag, migrationRecovery) {
  process.stdout.write(`${JSON.stringify({
    protocol: 'devbridge/stage0-status-v1',
    installationTag,
    stage0Protocol: STAGE0_PROTOCOL,
    migrationRecovery,
    activationState: selection.activationState,
    runtime: {
      head: selection.runtime.head,
      version: selection.runtime.version,
      minimumStage0Protocol: selection.runtime.minimumStage0Protocol,
      legacy: selection.runtime.minimumStage0Protocol === 0,
    },
  })}\n`);
  return 0;
}

export async function bootstrapStage0(argv = process.argv.slice(2), runner = defaultRunner, {
  importModuleFn = (url) => import(url),
  processAliveFn = processIsAlive,
} = {}) {
  assertSupportedNode();
  const args = parseStage0Args(argv);
  const paths = resolveStage0Paths(args);
  const installationTag = stage0InstallationTag(paths.home);
  process.env.DEVBRIDGE_INSTALLATION_TAG = installationTag;
  process.env.DEVBRIDGE_STAGE0_PROTOCOL = String(STAGE0_PROTOCOL);
  process.title = `DevBridge[${installationTag}]`;
  const migrationRecovery = reconcileStage0Migration(paths, { processAliveFn });
  const selection = ensureStage0Runtime(args, paths, runner);
  process.stdout.write(`[devbridge-stage0 ${installationTag}] activation=${selection.activationState} runtime=${selection.runtime.head}\n`);
  if (args.command === 'bootstrap-status') return printBootstrapStatus(selection, installationTag, migrationRecovery);
  if (args.command === 'migrate-legacy-runtime') {
    return migrateLegacyRuntime(argv, args, paths, selection, runner, importModuleFn, installationTag);
  }
  const module = await importBootstrap(selection.runtime, importModuleFn);
  return module.bootstrap(forwardedRuntimeArgs(argv), undefined, { stage0Protocol: STAGE0_PROTOCOL });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  bootstrapStage0().then((status) => { process.exitCode = status; }).catch((error) => {
    process.stderr.write(`[devbridge-stage0] ${error.message}\n`);
    process.exitCode = 1;
  });
}
