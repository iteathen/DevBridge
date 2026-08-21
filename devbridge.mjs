#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SOURCE_REPOSITORY = 'https://github.com/iteathen/DevBridge.git';
export const SOURCE_BRANCH = 'codex/temp-fast-functional';
export const STAGE0_PROTOCOL = 1;
const MIGRATION_PROTOCOL = 'devbridge/stage0-runtime-migration-v1';
const POLICY_PROTOCOL = 'devbridge/bootstrap-policy-v1';
const INSTALL_MANIFEST_PROTOCOL = 'devbridge/install-manifest-v1';
const ACTIVATION_PROTOCOL = 'devbridge/runtime-activation-v1';
const ACCEPTED_ACTIVATION_STATES = new Set([
  'healthy', 'candidate-planned', 'candidate-failed', 'candidate-validated',
  'drain-requested', 'activating', 'health-failed', 'rolled-back',
]);
const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const STAGE0_COMMANDS = new Set(['install', 'setup', 'uninstall', 'doctor', 'update', 'poll-once', 'run-once', 'start', 'daemon', 'status', 'logs', 'pause', 'resume', 'stop', 'restart']);
const STAGE0_VALUE_FLAGS = new Set(['--channel', '--release-mode', '--release-manifest', '--release-public-key', '--confirm']);
const CHANNELS = new Set(['testing', 'stable']);
const SCRUBBED_GIT_ENVIRONMENT = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ASKPASS', 'GIT_CONFIG', 'GIT_CONFIG_COUNT',
  'GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_WORK_TREE',
  'SSH_ASKPASS', 'SSH_AUTH_SOCK',
]);

function fail(message) { throw new Error(message); }

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
  let config = null;
  let noUpdate = false;
  let channel = null;
  let command = 'start';
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--home') {
      if (home !== null) fail('Only one --home value may be supplied.');
      home = takeValue(argv, index, value);
      index += 1;
    } else if (value === '--config') {
      if (config !== null) fail('Only one --config value may be supplied.');
      config = takeValue(argv, index, value);
      index += 1;
    } else if (value === '--no-update') {
      noUpdate = true;
    } else if (value === '--setup') {
      if (commandSeen) fail('--setup cannot be combined with another DevBridge command.');
      command = 'setup';
      commandSeen = true;
    } else if (value === '--channel') {
      if (channel !== null) fail('Only one --channel value may be supplied.');
      channel = takeValue(argv, index, value);
      if (!CHANNELS.has(channel)) fail(`Unknown DevBridge channel: ${channel}`);
      index += 1;
    } else if (STAGE0_VALUE_FLAGS.has(value)) {
      takeValue(argv, index, value);
      index += 1;
    } else if (STAGE0_COMMANDS.has(value)) {
      if (commandSeen) fail('Only one DevBridge command may be supplied.');
      command = value;
      commandSeen = true;
    }
  }
  return { home, config, noUpdate, command, channel };
}

export function resolveStage0Paths(args, environment = process.env) {
  const configuredHome = args.home ?? environment.DEVBRIDGE_HOME;
  const home = path.resolve(expandHome(configuredHome || path.join(homedir(), '.devbridge')));
  return {
    home,
    runtime: path.join(home, 'runtime'),
    runtimeCandidates: path.join(home, 'runtime-candidates'),
    activationState: path.join(home, 'runtime-activation.json'),
    config: path.resolve(expandHome(args.config || path.join(home, 'config.json'))),
    gitHome: path.join(home, 'bootstrap-git-home'),
    hooks: path.join(home, 'bootstrap-empty-hooks'),
    migrationLock: path.join(home, 'stage0-migration.lock'),
    migrationState: path.join(home, 'stage0-migration.json'),
    policy: path.join(home, 'bootstrap-policy.json'),
    installManifest: path.join(home, 'install-manifest.json'),
  };
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

export function validateRuntimeRepository(paths, runner) {
  const gitDirectory = path.join(paths.runtime, '.git');
  if (!existsSync(gitDirectory)) fail(`Managed runtime is not a Git checkout: ${paths.runtime}`);
  const remote = runGit(['remote', 'get-url', 'origin'], { paths, cwd: paths.runtime, runner }).stdout;
  if (normalizedRemote(remote) !== normalizedRemote(SOURCE_REPOSITORY)) fail('Managed runtime origin does not match the trusted DevBridge repository.');
  const dirty = runGit(['status', '--porcelain'], { paths, cwd: paths.runtime, runner }).stdout.trim();
  if (dirty) fail('Managed DevBridge runtime contains local changes; refusing to execute it.');
}

export function validateRuntimeShape(runtime) {
  const packagePath = path.join(runtime, 'package.json');
  const secureBootstrapPath = path.join(runtime, 'src', 'bootstrap', 'secure-bootstrap.mjs');
  if (!existsSync(packagePath) || !statSync(packagePath).isFile() || !existsSync(secureBootstrapPath) || !statSync(secureBootstrapPath).isFile()) {
    fail('Fetched DevBridge runtime does not contain the expected package/bootstrap shape.');
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(packagePath, 'utf8')); }
  catch { fail('Fetched DevBridge package.json is not valid JSON.'); }
  if (manifest?.name !== 'devbridge' || typeof manifest.version !== 'string') fail('Fetched runtime does not identify itself as DevBridge.');
  const stage0Protocol = manifest?.devbridge?.stage0Protocol;
  if (stage0Protocol != null && (!Number.isSafeInteger(stage0Protocol) || stage0Protocol < 1)) {
    fail('Fetched runtime declares an invalid stage-0 protocol.');
  }
  return {
    secureBootstrapPath,
    cliPath: path.join(runtime, 'src', 'cli.js'),
    version: manifest.version,
    stage0Protocol: stage0Protocol ?? 0,
  };
}

function exactHead(value) {
  const head = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(head) ? head : null;
}

function runtimeHead(paths, runner) {
  const head = exactHead(runGit(['rev-parse', 'HEAD'], { paths, cwd: paths.runtime, runner }).stdout);
  if (!head) fail('Managed DevBridge runtime does not have an exact Git head.');
  return head;
}

export function loadAcceptedStage0Runtime(paths, runner = defaultRunner) {
  if (!existsSync(paths.activationState)) return null;
  let record;
  try {
    const info = lstatSync(paths.activationState);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) fail('Accepted DevBridge activation state is not a bounded real file.');
    record = JSON.parse(readFileSync(paths.activationState, 'utf8'));
  } catch (error) {
    fail(`Accepted DevBridge activation state is invalid: ${error.message}`);
  }
  if (record?.protocol !== ACTIVATION_PROTOCOL || !ACCEPTED_ACTIVATION_STATES.has(record.state)) {
    fail('Accepted DevBridge activation state has an unsupported protocol or state.');
  }
  const head = exactHead(record.current?.head);
  if (!head) fail('Accepted DevBridge activation state does not identify an exact current head.');
  const expectedRuntime = path.join(paths.runtimeCandidates, head);
  if (path.resolve(record.current?.runtimeDir ?? '') !== path.resolve(expectedRuntime)) {
    fail('Accepted DevBridge activation state does not use its derived runtime directory.');
  }
  const expectedCli = path.join(expectedRuntime, 'src', 'cli.js');
  if (record.current?.cliPath != null && path.resolve(record.current.cliPath) !== path.resolve(expectedCli)) {
    fail('Accepted DevBridge activation state does not use its derived CLI path.');
  }
  const selectedPaths = { ...paths, runtime: expectedRuntime };
  validateRuntimeRepository(selectedPaths, runner);
  const observedHead = runtimeHead(selectedPaths, runner);
  if (observedHead !== head) fail('Accepted DevBridge runtime checkout does not match its recorded head.');
  const shape = validateRuntimeShape(expectedRuntime);
  if (shape.stage0Protocol !== STAGE0_PROTOCOL) {
    fail(`Accepted DevBridge runtime requires incompatible stage-0 protocol ${shape.stage0Protocol}; expected ${STAGE0_PROTOCOL}.`);
  }
  return { ...shape, head, accepted: true };
}

export function remoteSourceHead(paths, runner = defaultRunner) {
  const result = runGit(
    ['ls-remote', '--exit-code', '--heads', SOURCE_REPOSITORY, `refs/heads/${SOURCE_BRANCH}`],
    { paths, runner, allowFailure: true },
  );
  if (result.error || result.status !== 0) return null;
  return exactHead(String(result.stdout || '').trim().split(/\s+/u)[0]);
}

function atomicJson(filePath, value) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, filePath);
}

function readMigrationState(paths) {
  if (!existsSync(paths.migrationState)) return null;
  try {
    const value = JSON.parse(readFileSync(paths.migrationState, 'utf8'));
    return value?.protocol === MIGRATION_PROTOCOL ? value : null;
  } catch {
    fail(`Stage-0 migration state is not valid JSON: ${paths.migrationState}`);
  }
}

function resolveOperatorChannel(args, paths) {
  if (args.channel) return { channel: args.channel, source: 'explicit' };
  if (!existsSync(paths.policy)) return { channel: 'testing', source: 'default' };
  let policy;
  try { policy = JSON.parse(readFileSync(paths.policy, 'utf8')); }
  catch { fail(`Bootstrap policy is not valid JSON: ${paths.policy}`); }
  if (policy?.protocol !== POLICY_PROTOCOL || !CHANNELS.has(policy.channel)) {
    fail(`Bootstrap policy is invalid: ${paths.policy}`);
  }
  return { channel: policy.channel, source: 'persisted' };
}

function persistOperatorChannel(args, paths, channel) {
  if (args.command === 'status' || args.command === 'stop') return;
  const current = existsSync(paths.policy) ? (() => {
    try { return JSON.parse(readFileSync(paths.policy, 'utf8')); } catch { return null; }
  })() : null;
  if (current?.protocol === POLICY_PROTOCOL && current.channel === channel) return;
  atomicJson(paths.policy, { protocol: POLICY_PROTOCOL, channel, updatedAt: new Date().toISOString() });
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function recordStage0Install(paths, { runtimePreexisting, launcherPath }) {
  let manifest = { protocol: INSTALL_MANIFEST_PROTOCOL, home: paths.home, entries: [], updatedAt: new Date().toISOString() };
  if (existsSync(paths.installManifest)) {
    try { manifest = JSON.parse(readFileSync(paths.installManifest, 'utf8')); }
    catch { fail(`Install manifest is not valid JSON: ${paths.installManifest}`); }
    if (manifest?.protocol !== INSTALL_MANIFEST_PROTOCOL || path.resolve(manifest.home ?? '') !== paths.home || !Array.isArray(manifest.entries)) {
      fail(`Install manifest does not match this DevBridge home: ${paths.installManifest}`);
    }
  }
  const entries = new Map(manifest.entries.map((entry) => [`${entry.kind}:${entry.role}:${entry.stateDirectory ?? ''}:${entry.path ?? entry.identity ?? ''}`, entry]));
  const addPath = (role, target, ownership = 'created') => {
    const resolved = path.resolve(target);
    if (!isWithin(paths.home, resolved)) fail(`Install manifest path escapes the DevBridge home: ${resolved}`);
    const entry = { kind: 'path', role, path: resolved, ownership };
    entries.set(`${entry.kind}:${entry.role}::${entry.path}`, entry);
  };
  addPath('runtime', paths.runtime, runtimePreexisting ? 'verified-managed' : 'created');
  addPath('bootstrap-git-home', paths.gitHome, 'created');
  addPath('bootstrap-hooks', paths.hooks, 'created');
  if (existsSync(paths.policy)) addPath('bootstrap-policy', paths.policy, 'created');
  if (existsSync(paths.migrationState)) addPath('migration-state', paths.migrationState, 'created');
  if (launcherPath && isWithin(paths.home, launcherPath)) addPath('launcher', launcherPath, 'verified-managed');
  atomicJson(paths.installManifest, { ...manifest, entries: [...entries.values()], updatedAt: new Date().toISOString() });
}

function processIsObservedAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return null;
  }
}

function acquireMigrationLock(paths) {
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(paths.migrationLock, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ protocol: MIGRATION_PROTOCOL, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      closeSync(descriptor);
      descriptor = null;
      break;
    } catch (error) {
      if (descriptor != null) closeSync(descriptor);
      descriptor = null;
      if (error?.code !== 'EEXIST') throw error;
      let lock;
      try { lock = JSON.parse(readFileSync(paths.migrationLock, 'utf8')); }
      catch { fail(`Stage-0 migration lock is unreadable; inspect it before retrying: ${paths.migrationLock}`); }
      if (lock?.protocol !== MIGRATION_PROTOCOL || processIsObservedAlive(lock.pid) !== false) {
        fail(`Another or unverifiable stage-0 migration owns ${paths.migrationLock}; inspect that process before retrying.`);
      }
      unlinkSync(paths.migrationLock);
    }
  }
  if (descriptor != null || !existsSync(paths.migrationLock)) fail('Could not acquire the stage-0 migration lock.');
  return () => {
    try { unlinkSync(paths.migrationLock); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  };
}

function stopExistingRuntime(paths, shape, runner) {
  if (!existsSync(paths.config) || !existsSync(shape.cliPath)) return;
  const result = runner(process.execPath, [shape.cliPath, 'stop', '--config', paths.config], {
    cwd: paths.runtime,
    env: process.env,
    timeout: GIT_TIMEOUT_MS,
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail(`Could not cooperatively stop the installed DevBridge runtime before migration: ${String(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 2000)}`);
  }
}

function fetchMigrationCandidate(paths, runner) {
  const expected = remoteSourceHead(paths, runner);
  if (!expected) fail(`Could not resolve trusted DevBridge branch ${SOURCE_BRANCH}.`);
  const remoteRef = `refs/remotes/origin/${SOURCE_BRANCH}`;
  const fetchArgs = ['fetch', '--no-tags', '--prune'];
  if (existsSync(path.join(paths.runtime, '.git', 'shallow'))) fetchArgs.push('--unshallow');
  fetchArgs.push('origin', `+refs/heads/${SOURCE_BRANCH}:${remoteRef}`);
  runGit(fetchArgs, { paths, cwd: paths.runtime, runner });
  const observed = exactHead(runGit(['rev-parse', remoteRef], { paths, cwd: paths.runtime, runner }).stdout);
  const currentRemote = remoteSourceHead(paths, runner);
  if (!observed || observed !== expected || currentRemote !== expected) {
    fail('Trusted DevBridge branch changed while stage 0 was preparing the compatibility transition; retry from a stable observation.');
  }
  const packageResult = runGit(['show', `${observed}:package.json`], { paths, cwd: paths.runtime, runner });
  let manifest;
  try { manifest = JSON.parse(packageResult.stdout); } catch { fail('Stage-0 candidate package.json is not valid JSON.'); }
  if (manifest?.name !== 'devbridge' || manifest?.devbridge?.stage0Protocol !== STAGE0_PROTOCOL) {
    fail(`Trusted DevBridge candidate does not implement required stage-0 protocol ${STAGE0_PROTOCOL}.`);
  }
  runGit(['cat-file', '-e', `${observed}:src/bootstrap/secure-bootstrap.mjs`], { paths, cwd: paths.runtime, runner });
  return observed;
}

export function migrateStage0Runtime(args, paths, shape, runner = defaultRunner, {
  fetchCandidateFn = fetchMigrationCandidate,
} = {}) {
  if (shape.stage0Protocol === STAGE0_PROTOCOL) {
    const head = runtimeHead(paths, runner);
    const prior = readMigrationState(paths);
    if (prior && (prior.state === 'planned' || existsSync(paths.migrationLock))) {
      const release = acquireMigrationLock(paths);
      try {
        if (prior.state === 'planned') {
          if (prior.candidateHead !== head) fail('Stage-0 migration state does not match the active managed runtime.');
          atomicJson(paths.migrationState, { ...prior, state: 'activated', updatedAt: new Date().toISOString() });
        }
      } finally {
        release();
      }
    }
    return { ...shape, head, migrated: false };
  }
  if (shape.stage0Protocol > STAGE0_PROTOCOL) fail(`Installed runtime requires newer stage-0 protocol ${shape.stage0Protocol}; download the current launcher.`);
  if (args.noUpdate || args.command === 'status' || args.command === 'stop') {
    const head = runtimeHead(paths, runner);
    process.stdout.write(`[devbridge-stage0] update=required current=${head} command="update"; continuing without mutation because ${args.noUpdate ? '--no-update was supplied' : `${args.command} is a non-updating control command`}\n`);
    return { ...shape, head, migrated: false, compatibilityPending: true };
  }

  const release = acquireMigrationLock(paths);
  try {
    validateRuntimeRepository(paths, runner);
    const previousHead = runtimeHead(paths, runner);
    const candidateHead = fetchCandidateFn(paths, runner);
    const ancestry = runGit(['merge-base', '--is-ancestor', previousHead, candidateHead], {
      paths,
      cwd: paths.runtime,
      runner,
      allowFailure: true,
    });
    if (ancestry.error || ancestry.status !== 0) {
      fail('Stage-0 compatibility transition is not a fast-forward from the installed runtime; refusing automatic replacement.');
    }

    stopExistingRuntime(paths, shape, runner);
    runGit(['update-ref', 'refs/devbridge/stage0-previous', previousHead], { paths, cwd: paths.runtime, runner });
    const planned = {
      protocol: MIGRATION_PROTOCOL,
      state: 'planned',
      branch: SOURCE_BRANCH,
      previousHead,
      candidateHead,
      updatedAt: new Date().toISOString(),
    };
    atomicJson(paths.migrationState, planned);
    runGit(['checkout', '--detach', '--force', candidateHead], { paths, cwd: paths.runtime, runner });
    validateRuntimeRepository(paths, runner);
    const migrated = validateRuntimeShape(paths.runtime);
    const activeHead = runtimeHead(paths, runner);
    if (activeHead !== candidateHead || migrated.stage0Protocol !== STAGE0_PROTOCOL) {
      fail('Stage-0 compatibility transition did not activate the exact verified candidate.');
    }
    atomicJson(paths.migrationState, { ...planned, state: 'activated', updatedAt: new Date().toISOString() });
    process.stdout.write(`[devbridge-stage0] migrated runtime ${previousHead} -> ${candidateHead}; rollback ref=refs/devbridge/stage0-previous\n`);
    return { ...migrated, head: activeHead, migrated: true };
  } finally {
    release();
  }
}

export function ensureStage0Runtime(args, paths, runner = defaultRunner) {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.gitHome, { recursive: true });
  mkdirSync(paths.hooks, { recursive: true });
  if (!existsSync(paths.runtime)) {
    if (args.noUpdate) fail('--no-update requires an existing managed DevBridge runtime.');
    runGit(['clone', '--no-tags', '--depth', '1', '--single-branch', '--branch', SOURCE_BRANCH, SOURCE_REPOSITORY, paths.runtime], { paths, runner });
  }
  validateRuntimeRepository(paths, runner);
  const shape = validateRuntimeShape(paths.runtime);
  return migrateStage0Runtime(args, paths, shape, runner);
}

function printHelp() {
  process.stdout.write(
    'Usage: node devbridge.mjs [command] [options]\n\n' +
    'Commands:\n' +
    '  install     Install/initialize the managed runtime and local configuration\n' +
    '  setup       Discover and select channels, repositories, task authors, and environments\n' +
    '  uninstall   Remove with --app-only or ownership-proven --purge (requires REMOVE)\n' +
    '  doctor      Check prerequisites, configuration, runtime, and update availability\n' +
    '  update      Validate and activate an available runtime, then launch DevBridge\n' +
    '  start       Launch the supervised daemon headlessly (default)\n' +
    '  daemon      Launch and supervise DevBridge in the foreground\n' +
    '  poll-once   Poll configured repositories once\n' +
    '  run-once    Poll and execute one bounded cycle\n' +
    '  status      Inspect daemon state without updating\n' +
    '  logs        Show the bounded headless-supervisor log tail\n' +
    '  pause       Pause admission at a safe cycle boundary\n' +
    '  resume      Resume a paused daemon\n' +
    '  stop        Cooperatively stop without updating\n' +
    '  restart     Cooperatively restart under the supervisor\n\n' +
    'Options:\n' +
    '  --home <path>       Use a specific DevBridge home\n' +
    '  --config <path>     Use a specific local configuration\n' +
    '  --channel <name>    Select and remember testing (fast branch) or stable (main)\n' +
    '  --repository <id>    Replace polling selection (repeat for multiple owner/name values)\n' +
    '  --trusted-author <id> Replace trusted task-author IDs (repeat for multiple IDs)\n' +
    '  --repository-discovery | --no-repository-discovery\n' +
    '  --environment <id>   Set up a persistent VM for a repository (repeatable)\n' +
    '  --all-environments | --no-environments\n' +
    '  --enable-execution | --disable-execution\n' +
    '  --allow-provider-elevation  Permit one bounded setup UAC request (setup only; requires APPLY)\n' +
    '  --app-only | --purge  Select uninstall scope (uninstall only)\n' +
    '  --confirm <token>     Exact APPLY for setup authority changes or REMOVE for uninstall\n' +
    '  --no-update         Do not discover or activate updates\n' +
    '  --setup             Explicitly re-enter setup (same as the setup command)\n' +
    '  --help              Show this help without installing\n',
  );
}

export async function bootstrapStage0(argv = process.argv.slice(2), runner = defaultRunner) {
  assertSupportedNode();
  if (argv.includes('--help') || argv[0] === 'help') {
    printHelp();
    return 0;
  }
  const args = parseStage0Args(argv);
  const paths = resolveStage0Paths(args);
  const channel = resolveOperatorChannel(args, paths);
  const runtimePreexisting = existsSync(paths.runtime);
  const stage0Runtime = ensureStage0Runtime(args, paths, runner);
  const runtime = loadAcceptedStage0Runtime(paths, runner) ?? stage0Runtime;
  if (channel.source !== 'default') persistOperatorChannel(args, paths, channel.channel);
  recordStage0Install(paths, { runtimePreexisting, launcherPath: process.argv[1] ? path.resolve(process.argv[1]) : null });
  const module = await import(pathToFileURL(runtime.secureBootstrapPath).href);
  if (typeof module.bootstrap !== 'function') fail('Managed DevBridge runtime does not export the secure bootstrap entrypoint.');
  const effectiveArgv = args.channel || channel.source === 'default'
    ? argv
    : [...argv, '--channel', channel.channel, ...(args.command === 'setup' ? ['--prompt-channel'] : [])];
  return module.bootstrap(effectiveArgv);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  bootstrapStage0().then((status) => { process.exitCode = status; }).catch((error) => {
    process.stderr.write(`[devbridge-stage0] ${error.message}\n`);
    process.exitCode = 1;
  });
}
