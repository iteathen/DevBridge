#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SOURCE_REPOSITORY = 'https://github.com/iteathen/DevBridge.git';
const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
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
  let noUpdate = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--home') {
      if (home !== null) fail('Only one --home value may be supplied.');
      home = takeValue(argv, index, value);
      index += 1;
    } else if (value === '--no-update') {
      noUpdate = true;
    }
  }
  return { home, noUpdate };
}

export function resolveStage0Paths(args, environment = process.env) {
  const configuredHome = args.home ?? environment.DEVBRIDGE_HOME;
  const home = path.resolve(expandHome(configuredHome || path.join(homedir(), '.devbridge')));
  return {
    home,
    runtime: path.join(home, 'runtime'),
    gitHome: path.join(home, 'bootstrap-git-home'),
    hooks: path.join(home, 'bootstrap-empty-hooks'),
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

function validateRuntimeRepository(paths, runner) {
  const gitDirectory = path.join(paths.runtime, '.git');
  if (!existsSync(gitDirectory)) fail(`Managed runtime is not a Git checkout: ${paths.runtime}`);
  const remote = runGit(['remote', 'get-url', 'origin'], { paths, cwd: paths.runtime, runner }).stdout;
  if (normalizedRemote(remote) !== normalizedRemote(SOURCE_REPOSITORY)) fail('Managed runtime origin does not match the trusted DevBridge repository.');
  const dirty = runGit(['status', '--porcelain'], { paths, cwd: paths.runtime, runner }).stdout.trim();
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
  return { secureBootstrapPath, version: manifest.version };
}

export function ensureStage0Runtime(args, paths, runner = defaultRunner) {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.gitHome, { recursive: true });
  mkdirSync(paths.hooks, { recursive: true });
  if (!existsSync(paths.runtime)) {
    if (args.noUpdate) fail('--no-update requires an existing managed DevBridge runtime.');
    runGit(['clone', '--no-tags', '--depth', '1', '--single-branch', '--branch', 'main', SOURCE_REPOSITORY, paths.runtime], { paths, runner });
  }
  validateRuntimeRepository(paths, runner);
  return validateRuntimeShape(paths.runtime);
}

export async function bootstrapStage0(argv = process.argv.slice(2), runner = defaultRunner) {
  assertSupportedNode();
  const args = parseStage0Args(argv);
  const paths = resolveStage0Paths(args);
  const runtime = ensureStage0Runtime(args, paths, runner);
  const module = await import(pathToFileURL(runtime.secureBootstrapPath).href);
  if (typeof module.bootstrap !== 'function') fail('Managed DevBridge runtime does not export the secure bootstrap entrypoint.');
  return module.bootstrap(argv);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  bootstrapStage0().then((status) => { process.exitCode = status; }).catch((error) => {
    process.stderr.write(`[devbridge-stage0] ${error.message}\n`);
    process.exitCode = 1;
  });
}
