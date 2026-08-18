#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SOURCE_REPOSITORY = 'https://github.com/iteathen/PATCH-POLLER.git';
const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const COMMANDS = new Set(['doctor', 'poll-once', 'run-once', 'daemon', 'status', 'stop', 'restart']);
const CHANNELS = Object.freeze({
  // While v0.1 is still in PR #3, testing follows that branch. Once that
  // branch is removed after integration, the launcher falls back to main.
  testing: Object.freeze(['sol/foundation-bootstrap', 'main']),
  stable: Object.freeze(['main']),
});
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

function fail(message) {
  throw new Error(message);
}

export function assertSupportedNode(version = process.versions.node) {
  const parts = String(version).split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length < 3 || parts.some((value) => !Number.isInteger(value))) {
    fail(`Could not parse Node.js version: ${version}`);
  }
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parts[index] > MINIMUM_NODE[index]) return;
    if (parts[index] < MINIMUM_NODE[index]) {
      fail('PATCH-POLLER requires Node.js 22.16.0 or newer.');
    }
  }
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
  return value;
}

export function parseBootstrapArgs(argv) {
  const result = {
    command: 'daemon',
    channel: 'testing',
    home: null,
    config: null,
    update: true,
  };
  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (COMMANDS.has(value)) {
      if (commandSeen) fail('Only one PATCH-POLLER command may be supplied.');
      result.command = value;
      commandSeen = true;
      continue;
    }
    if (value === '--channel') {
      result.channel = takeValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === '--home') {
      result.home = takeValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === '--config') {
      result.config = takeValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === '--no-update') {
      result.update = false;
      continue;
    }
    fail(`Unknown bootstrap argument: ${value}`);
  }
  if (!Object.hasOwn(CHANNELS, result.channel)) {
    fail(`Unknown PATCH-POLLER channel: ${result.channel}`);
  }
  return result;
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export function resolveBootstrapPaths(args, environment = process.env) {
  const configuredHome = args.home ?? environment.PATCH_POLLER_HOME;
  const home = path.resolve(expandHome(configuredHome || path.join(homedir(), '.patch-poller')));
  const runtime = path.join(home, 'runtime');
  const config = path.resolve(expandHome(args.config || path.join(home, 'config.json')));
  return {
    home,
    runtime,
    config,
    gitHome: path.join(home, 'bootstrap-git-home'),
    hooks: path.join(home, 'bootstrap-empty-hooks'),
  };
}

const SCRUBBED_GIT_ENVIRONMENT = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ASKPASS',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_WORK_TREE',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
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
  return [
    '-c', `core.hooksPath=${paths.hooks}`,
    '-c', 'credential.helper=',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=never',
  ];
}

function defaultRunner(executable, args, options) {
  return spawnSync(executable, args, {
    ...options,
    shell: false,
    encoding: options.stdio === 'inherit' ? undefined : 'utf8',
    maxBuffer: CAPTURE_LIMIT,
  });
}

function formatFailure(executable, args, result) {
  const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
  const suffix = detail ? `: ${detail.slice(0, 2000)}` : '';
  return `${executable} ${args.join(' ')} failed (exit ${result.status ?? 'spawn-error'})${suffix}`;
}

export function runGit(args, { paths, cwd = undefined, runner = defaultRunner, allowFailure = false } = {}) {
  const environment = managedGitEnvironment(paths);
  const fullArgs = [...gitPrefix(paths), ...args];
  const result = runner('git', fullArgs, {
    cwd,
    env: environment,
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

function verifyRuntimeRepository(paths, runner) {
  const gitDirectory = path.join(paths.runtime, '.git');
  if (!existsSync(gitDirectory)) fail(`Managed runtime is not a Git checkout: ${paths.runtime}`);
  const remote = runGit(['remote', 'get-url', 'origin'], { paths, cwd: paths.runtime, runner }).stdout;
  if (normalizedRemote(remote) !== normalizedRemote(SOURCE_REPOSITORY)) {
    fail('Managed runtime origin does not match the trusted PATCH-POLLER repository.');
  }
  const dirty = runGit(['status', '--porcelain'], { paths, cwd: paths.runtime, runner }).stdout.trim();
  if (dirty) {
    fail('Managed PATCH-POLLER runtime contains local changes; refusing to overwrite it automatically.');
  }
}

function remoteBranchExists(ref, paths, runner) {
  const result = runGit(
    ['ls-remote', '--exit-code', '--heads', SOURCE_REPOSITORY, `refs/heads/${ref}`],
    { paths, runner, allowFailure: true },
  );
  return !result.error && result.status === 0 && String(result.stdout || '').trim().length > 0;
}

export function resolveChannelRef(channel, { paths, runner = defaultRunner } = {}) {
  for (const ref of CHANNELS[channel]) {
    if (remoteBranchExists(ref, paths, runner)) return ref;
  }
  fail(`No trusted branch is available for PATCH-POLLER channel ${channel}.`);
}

function validateRuntimeShape(runtime) {
  const packagePath = path.join(runtime, 'package.json');
  const cliPath = path.join(runtime, 'src', 'cli.js');
  if (!existsSync(packagePath) || !statSync(packagePath).isFile() ||
      !existsSync(cliPath) || !statSync(cliPath).isFile()) {
    fail('Fetched PATCH-POLLER runtime does not contain the expected package/CLI shape.');
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch {
    fail('Fetched PATCH-POLLER package.json is not valid JSON.');
  }
  if (manifest?.name !== 'patch-poller' || typeof manifest.version !== 'string') {
    fail('Fetched runtime does not identify itself as PATCH-POLLER.');
  }
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
    runGit([
      'clone', '--no-tags', '--depth', '1', '--single-branch', '--branch', ref,
      SOURCE_REPOSITORY, paths.runtime,
    ], { paths, runner });
  } else {
    verifyRuntimeRepository(paths, runner);
    runGit([
      'fetch', '--no-tags', '--depth', '1', '--prune', 'origin', `refs/heads/${ref}`,
    ], { paths, cwd: paths.runtime, runner });
    runGit(['checkout', '--detach', '--force', 'FETCH_HEAD'], {
      paths, cwd: paths.runtime, runner,
    });
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
    cwd: paths.runtime,
    env: process.env,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
  if (result.error) fail(`Could not start PATCH-POLLER ${command}: ${result.error.message}`);
  return result.status ?? 1;
}

export function bootstrap(argv = process.argv.slice(2), runner = defaultRunner) {
  assertSupportedNode();
  const args = parseBootstrapArgs(argv);
  const paths = resolveBootstrapPaths(args);
  const runtime = ensureRuntime(args, paths, runner);
  process.stdout.write(
    `[patch-poller-bootstrap] channel=${args.channel} ref=${runtime.ref} ` +
    `version=${runtime.version} head=${runtime.head}\n`,
  );

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
  try {
    process.exitCode = bootstrap();
  } catch (error) {
    process.stderr.write(`[patch-poller-bootstrap] ${error.message}\n`);
    process.exitCode = 1;
  }
}
