#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  constants,
  closeSync,
  copyFileSync,
  existsSync,
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
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

const SOURCE_REPOSITORY = 'https://github.com/iteathen/DevBridge.git';
export const STAGE0_PROTOCOL = 1;
const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const COMMANDS = new Set(['install', 'setup', 'uninstall', 'doctor', 'update', 'poll-once', 'run-once', 'start', 'daemon', 'status', 'logs', 'pause', 'resume', 'stop', 'restart']);
const CONFIGURATION_VALUE_FLAGS = new Set(['--repository', '--trusted-author', '--environment']);
const CONFIGURATION_BOOLEAN_FLAGS = new Set([
  '--repository-discovery', '--no-repository-discovery',
  '--all-environments', '--no-environments', '--enable-execution', '--disable-execution',
  '--allow-provider-elevation',
]);
const CHANNELS = Object.freeze({
  testing: Object.freeze(['codex/temp-fast-functional']),
  stable: Object.freeze(['main']),
});
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 60_000;
const CHILD_RESTART_BACKOFF_MS = 5_000;
const BOOTSTRAP_POLICY_PROTOCOL = 'devbridge/bootstrap-policy-v1';

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

export function parseBootstrapArgs(argv) {
  const result = { command: 'start', channel: 'testing', home: null, config: null, update: true };
  let commandSeen = false;
  let configurationSeen = false;
  let uninstallSeen = false;
  let confirmSeen = false;
  let appOnly = false;
  let purge = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--setup') {
      if (commandSeen) fail('--setup cannot be combined with another DevBridge command');
      result.command = 'setup';
      commandSeen = true;
      continue;
    }
    if (COMMANDS.has(value)) {
      if (commandSeen) fail('Only one DevBridge command may be supplied.');
      result.command = value;
      commandSeen = true;
      continue;
    }
    if (value === '--channel') { result.channel = takeValue(argv, index, value); index += 1; continue; }
    if (value === '--home') { result.home = takeValue(argv, index, value); index += 1; continue; }
    if (value === '--config') { result.config = takeValue(argv, index, value); index += 1; continue; }
    if (value === '--no-update') { result.update = false; continue; }
    if (value === '--prompt-channel') { continue; }
    if (value === '--app-only') { uninstallSeen = true; appOnly = true; continue; }
    if (value === '--purge') { uninstallSeen = true; purge = true; continue; }
    if (value === '--confirm') { takeValue(argv, index, value); confirmSeen = true; index += 1; continue; }
    if (CONFIGURATION_VALUE_FLAGS.has(value)) {
      takeValue(argv, index, value);
      configurationSeen = true;
      index += 1;
      continue;
    }
    if (CONFIGURATION_BOOLEAN_FLAGS.has(value)) {
      configurationSeen = true;
      continue;
    }
    fail(`Unknown bootstrap argument: ${value}`);
  }
  if (!Object.hasOwn(CHANNELS, result.channel)) fail(`Unknown DevBridge channel: ${result.channel}`);
  if (result.command === 'update' && !result.update) fail('update cannot be combined with --no-update');
  if (configurationSeen && result.command !== 'setup') fail('repository/task-author selection flags require the setup command');
  if (uninstallSeen && result.command !== 'uninstall') fail('removal flags require the uninstall command');
  if (confirmSeen && !['setup', 'uninstall'].includes(result.command)) fail('--confirm requires the setup or uninstall command');
  if (appOnly && purge) fail('Choose only one uninstall mode: --app-only or --purge');
  return result;
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return value;
}

export function resolveBootstrapPaths(args, environment = process.env) {
  const configuredHome = args.home ?? environment.DEVBRIDGE_HOME;
  const home = path.resolve(expandHome(configuredHome || path.join(homedir(), '.devbridge')));
  const runtime = path.join(home, 'runtime');
  const config = path.resolve(expandHome(args.config || path.join(home, 'config.json')));
  return { home, runtime, config, gitHome: path.join(home, 'bootstrap-git-home'), hooks: path.join(home, 'bootstrap-empty-hooks'), policy: path.join(home, 'bootstrap-policy.json') };
}

export async function selectBootstrapChannel(paths, current, argv, {
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if ((argv.includes('--channel') && !argv.includes('--prompt-channel')) || input.isTTY !== true || output.isTTY !== true) return current;
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question(`Runtime channel: testing (fast branch) or stable (main) [${current}]: `)).trim().toLowerCase();
    const selected = answer || current;
    if (!Object.hasOwn(CHANNELS, selected)) fail('Runtime channel must be testing or stable.');
    return selected;
  } finally {
    prompt.close();
  }
}

export function persistBootstrapChannel(paths, channel) {
  if (!Object.hasOwn(CHANNELS, channel)) fail('Runtime channel must be testing or stable.');
  const temp = `${paths.policy}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ protocol: BOOTSTRAP_POLICY_PROTOCOL, channel, updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, paths.policy);
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
  if (normalizedRemote(remote) !== normalizedRemote(SOURCE_REPOSITORY)) fail('Managed runtime origin does not match the trusted DevBridge repository.');
  const dirty = runGit(['status', '--porcelain'], { paths, cwd: paths.runtime, runner }).stdout.trim();
  if (dirty) fail('Managed DevBridge runtime contains local changes; refusing to overwrite it automatically.');
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
  fail(`No trusted branch is available for DevBridge channel ${channel}.`);
}

function validateRuntimeShape(runtime) {
  const packagePath = path.join(runtime, 'package.json');
  const cliPath = path.join(runtime, 'src', 'cli.js');
  if (!existsSync(packagePath) || !statSync(packagePath).isFile() || !existsSync(cliPath) || !statSync(cliPath).isFile()) fail('Fetched DevBridge runtime does not contain the expected package/CLI shape.');
  let manifest;
  try { manifest = JSON.parse(readFileSync(packagePath, 'utf8')); } catch { fail('Fetched DevBridge package.json is not valid JSON.'); }
  if (manifest?.name !== 'devbridge' || typeof manifest.version !== 'string') fail('Fetched runtime does not identify itself as DevBridge.');
  const stage0Protocol = manifest?.devbridge?.stage0Protocol ?? 0;
  if (!Number.isSafeInteger(stage0Protocol) || stage0Protocol < 0) fail('Fetched runtime declares an invalid stage-0 protocol.');
  return { cliPath, version: manifest.version, stage0Protocol };
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
  const example = path.join(paths.runtime, 'config', 'devbridge.example.json');
  if (!existsSync(example)) fail('Fetched runtime is missing the safe example configuration.');
  mkdirSync(path.dirname(paths.config), { recursive: true });
  copyFileSync(example, paths.config, constants.COPYFILE_EXCL);
  let initialized;
  try { initialized = JSON.parse(readFileSync(paths.config, 'utf8')); }
  catch { fail('Fetched runtime example configuration is not valid JSON.'); }
  if (initialized?.workspace?.root === '~/.devbridge/workspaces') initialized.workspace.root = path.join(paths.home, 'workspaces');
  if (initialized?.state?.directory === '~/.devbridge/state') initialized.state.directory = path.join(paths.home, 'state');
  const temp = `${paths.config}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(initialized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, paths.config);
  return true;
}

export function migrateLocalConfig(paths) {
  if (!existsSync(paths.config)) return { changed: false, reason: 'missing' };
  const original = readFileSync(paths.config, 'utf8');
  let config;
  try { config = JSON.parse(original); }
  catch { fail(`Local DevBridge config is not valid JSON: ${paths.config}`); }
  const github = config?.github;
  if (!github || typeof github !== 'object' || Array.isArray(github)) return { changed: false, reason: 'not-applicable' };
  const hasSingle = Object.hasOwn(github, 'queueRepository');
  const hasMultiple = Object.hasOwn(github, 'queueRepositories');
  if (!hasSingle) return { changed: false, reason: 'current' };
  if (hasMultiple) fail('Local config contains both singular and plural queue repository settings; refusing an ambiguous migration.');
  if (typeof github.queueRepository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(github.queueRepository)) {
    fail('Local config singular queue repository is not a valid owner/name value.');
  }

  const backup = `${paths.config}.before-bootstrap-migration-v1`;
  if (!existsSync(backup)) copyFileSync(paths.config, backup, constants.COPYFILE_EXCL);
  else if (readFileSync(backup, 'utf8') !== original) fail(`Existing config migration backup does not match the current source config: ${backup}`);
  const migrated = structuredClone(config);
  migrated.github.queueRepositories = [github.queueRepository];
  delete migrated.github.queueRepository;
  const temp = `${paths.config}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(migrated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, paths.config);
  return { changed: true, backup };
}

function configurationSelections(argv) {
  const repositories = [];
  const trustedAuthors = [];
  let discovery = null;
  let confirm = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--repository') { repositories.push(takeValue(argv, index, value)); index += 1; continue; }
    if (value === '--trusted-author') { trustedAuthors.push(takeValue(argv, index, value)); index += 1; continue; }
    if (value === '--confirm') { confirm = takeValue(argv, index, value); index += 1; continue; }
    if (value === '--repository-discovery') discovery = true;
    if (value === '--no-repository-discovery') discovery = false;
  }
  const environmentIntent = argv.some((value) => ['--environment', '--all-environments', '--no-environments', '--enable-execution', '--disable-execution'].includes(value));
  return { repositories, trustedAuthors, discovery, confirm, supplied: repositories.length > 0 || trustedAuthors.length > 0 || discovery != null || environmentIntent };
}

function selectionValues(value) {
  return String(value || '').split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean);
}

function uniqueValues(values, key = (value) => String(value).toLowerCase()) {
  const observed = new Set();
  return values.filter((value) => {
    const identity = key(value);
    if (observed.has(identity)) return false;
    observed.add(identity);
    return true;
  });
}

function mergeRepositoryOptions(options, additions) {
  const merged = new Map(options.map((entry) => [entry.name.toLowerCase(), entry]));
  for (const entry of additions) merged.set(entry.name.toLowerCase(), entry);
  return [...merged.values()];
}

async function selectRepositories(value, options, fallback, {
  discovery = null,
  numericOptions = true,
} = {}) {
  const selected = selectionValues(value);
  if (selected.length === 0) return { values: fallback, verified: [] };
  const values = [];
  const verified = [];
  for (const entry of selected) {
    if (entry.toLowerCase() === 'all') {
      if (options.length < 1) fail('No verified discovered repositories are available for "all".');
      values.push(...options.map((option) => option.name));
      continue;
    }
    if (/^\d+$/u.test(entry)) {
      if (!numericOptions) fail('Repository command-line selections must use owner/name or all.');
      const option = options[Number.parseInt(entry, 10) - 1];
      if (!option) fail(`Repository option ${entry} is out of range.`);
      values.push(option.name);
      continue;
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(entry)) fail(`Custom repository ${entry} must be owner/name.`);
    const known = options.find((option) => option.name.toLowerCase() === entry.toLowerCase());
    if (known) {
      values.push(known.name);
      continue;
    }
    if (!discovery || typeof discovery.resolveRepository !== 'function') {
      fail(`Custom repository ${entry} cannot be accepted because GitHub verification is unavailable.`);
    }
    let resolved;
    try { resolved = await discovery.resolveRepository(entry); }
    catch (error) { fail(`GitHub could not verify custom repository ${entry}: ${String(error?.message ?? error)}`); }
    values.push(resolved.name);
    verified.push(resolved);
  }
  return { values: uniqueValues(values), verified };
}

async function selectAuthors(value, options, fallback, {
  discovery = null,
  authenticatedUser = null,
  numericOptions = true,
} = {}) {
  const selected = selectionValues(value);
  if (selected.length === 0) return { values: fallback, verified: [] };
  const values = [];
  const verified = [];
  for (const entry of selected) {
    if (entry.toLowerCase() === 'self') {
      if (!authenticatedUser?.id) fail('The authenticated GitHub user could not be verified for the self selection.');
      values.push(authenticatedUser.id);
      continue;
    }
    if (entry.startsWith('id:')) {
      const id = entry.slice(3);
      if (!/^\d+$/u.test(id)) fail('Manual task-author IDs must use id:<numeric-id>.');
      if (!discovery || typeof discovery.resolveAuthorId !== 'function') fail(`GitHub verification is unavailable for actor ID ${id}.`);
      let resolved;
      try { resolved = await discovery.resolveAuthorId(id); }
      catch (error) { fail(`GitHub could not verify actor ID ${id}: ${String(error?.message ?? error)}`); }
      values.push(resolved.id);
      verified.push(resolved);
      continue;
    }
    if (/^\d+$/u.test(entry)) {
      if (numericOptions) {
        const option = options[Number.parseInt(entry, 10) - 1];
        if (!option) fail(`Task-author option ${entry} is out of range; use id:<numeric-id> for manual entry.`);
        values.push(option.id);
        continue;
      }
      if (!discovery || typeof discovery.resolveAuthorId !== 'function') fail(`GitHub verification is unavailable for actor ID ${entry}.`);
      let resolved;
      try { resolved = await discovery.resolveAuthorId(entry); }
      catch (error) { fail(`GitHub could not verify actor ID ${entry}: ${String(error?.message ?? error)}`); }
      values.push(resolved.id);
      verified.push(resolved);
      continue;
    }
    const known = options.find((option) => option.login.toLowerCase() === entry.toLowerCase());
    if (known) {
      values.push(known.id);
      continue;
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(entry)) {
      fail('Task-author selections must be option numbers, self, a GitHub login, or id:<numeric-id>.');
    }
    if (!discovery || typeof discovery.resolveAuthor !== 'function') fail(`GitHub verification is unavailable for actor login ${entry}.`);
    let resolved;
    try { resolved = await discovery.resolveAuthor(entry); }
    catch (error) { fail(`GitHub could not verify actor login ${entry}: ${String(error?.message ?? error)}`); }
    values.push(resolved.id);
    verified.push(resolved);
  }
  return { values: uniqueValues(values, (value) => String(value)), verified };
}

function validateRepositorySelections(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 30) fail('Repository selection must contain 1-30 owner/name values.');
  if (values.some((value) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value))) fail('Every repository selection must be owner/name.');
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) fail('Repository selection contains duplicates.');
  return values;
}

function validateTrustedAuthors(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100 || values.some((value) => !/^\d+$/u.test(value))) {
    fail('Trusted task-author selection must contain 1-100 numeric GitHub actor IDs.');
  }
  if (new Set(values).size !== values.length) fail('Trusted task-author selection contains duplicates.');
  return values;
}

function parseYesNo(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['y', 'yes', 'true', '1'].includes(normalized)) return true;
  if (['n', 'no', 'false', '0'].includes(normalized)) return false;
  fail('Repository discovery selection must be yes or no.');
}

function writeConfiguredLocalConfig(paths, original, value) {
  const backup = `${paths.config}.before-setup`;
  const backupTemp = `${backup}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(backupTemp, original, { encoding: 'utf8', mode: 0o600 });
  renameSync(backupTemp, backup);
  const temp = `${paths.config}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, paths.config);
  return backup;
}

export async function configureLocalConfig(paths, argv, {
  input = process.stdin,
  output = process.stdout,
  discovery = null,
  discoveryError = null,
  promptFactory = createInterface,
} = {}) {
  const original = readFileSync(paths.config, 'utf8');
  let config;
  try { config = JSON.parse(original); } catch { fail(`Local DevBridge config is not valid JSON: ${paths.config}`); }
  if (!config?.github || typeof config.github !== 'object' || Array.isArray(config.github)) fail('Local DevBridge config does not contain a GitHub policy object.');
  const currentRepositories = validateRepositorySelections(config.github.queueRepositories);
  const currentAuthors = validateTrustedAuthors(config.github.trustedActorIds);
  const currentDiscovery = config.github.repositoryDiscovery?.enabled === true;
  let selections = configurationSelections(argv);
  let repositoryOptions = [];
  let repositoryOptionsTruncated = false;
  let authorOptions = [];
  let authorWarnings = [];
  let authorOptionsTruncated = false;
  let authenticatedUser = null;
  let observedDiscoveryError = discoveryError ? String(discoveryError?.message ?? discoveryError) : null;

  if (discovery) {
    try {
      const observed = await discovery.listRepositories();
      repositoryOptions = observed.records;
      repositoryOptionsTruncated = observed.truncated === true;
    } catch (error) {
      observedDiscoveryError = String(error?.message ?? error);
    }
  }

  if (!selections.supplied && input.isTTY === true && output.isTTY === true) {
    const prompt = promptFactory({ input, output });
    try {
      if (repositoryOptions.length > 0) {
        output.write('\nAuthenticated repositories with issues enabled:\n');
        repositoryOptions.forEach((entry, index) => output.write(`  ${index + 1}. ${entry.name}${entry.private ? ' (private)' : ''} [id ${entry.id}]\n`));
        if (repositoryOptionsTruncated) output.write('  Results are truncated at the bounded discovery limit; manual owner/name entry remains available.\n');
      } else if (observedDiscoveryError) {
        output.write(`\nRepository discovery unavailable: ${observedDiscoveryError.slice(0, 500)}\n`);
      }

      while (true) {
        let repositories;
        while (true) {
          const answer = await prompt.question(`Repositories to poll (numbers, all, or verified owner/name; separate with spaces or commas) [${currentRepositories.join(', ')}]: `);
          try {
            const selected = await selectRepositories(
              answer,
              repositoryOptions,
              currentRepositories,
              { discovery, numericOptions: true },
            );
            repositories = validateRepositorySelections(selected.values);
            repositoryOptions = mergeRepositoryOptions(repositoryOptions, selected.verified);
            break;
          } catch (error) {
            output.write(`  Invalid repository selection: ${String(error?.message ?? error)} Try again.\n`);
          }
        }

        let repositoryDiscovery;
        while (true) {
          const answer = await prompt.question(`Discover additional authorized repositories (${currentDiscovery ? 'yes' : 'no'}) [${currentDiscovery ? 'yes' : 'no'}]: `);
          try {
            repositoryDiscovery = parseYesNo(answer, currentDiscovery);
            break;
          } catch (error) {
            output.write(`  Invalid repository discovery selection: ${String(error?.message ?? error)} Try again.\n`);
          }
        }

        authorOptions = [];
        authorWarnings = [];
        authorOptionsTruncated = false;
        authenticatedUser = null;
        if (discovery && repositories.length > 0) {
          try {
            const observed = await discovery.listAuthors(repositories);
            authorOptions = observed.records;
            authorWarnings = observed.warnings;
            authorOptionsTruncated = observed.truncated === true;
            authenticatedUser = observed.authenticatedUser ?? null;
          } catch (error) {
            authorWarnings = [{ repository: null, reason: String(error?.message ?? error).slice(0, 500) }];
          }
        }
        if (authorOptions.length > 0) {
          output.write('\nCandidate remote task authors (listing is not trust):\n');
          authorOptions.forEach((entry, index) => {
            const self = authenticatedUser?.id === entry.id ? ' (authenticated user)' : '';
            const via = entry.repositories.length ? ` via ${entry.repositories.join(', ')}` : '';
            output.write(`  ${index + 1}. ${entry.login} [id ${entry.id}]${self}${via}\n`);
          });
          if (authorOptionsTruncated) output.write('  Results are truncated; verified login and id:<numeric-id> entry remain available.\n');
        }
        for (const warning of authorWarnings) output.write(`  Author discovery warning${warning.repository ? ` for ${warning.repository}` : ''}: ${warning.reason}\n`);

        let trustedAuthors;
        let verifiedAuthors = [];
        while (true) {
          const answer = await prompt.question(`Trusted remote task authors (numbers, self, verified login, or id:<numeric-id>; separate with spaces or commas) [${currentAuthors.join(', ')}]: `);
          try {
            const selected = await selectAuthors(
              answer,
              authorOptions,
              currentAuthors,
              { discovery, authenticatedUser, numericOptions: true },
            );
            trustedAuthors = validateTrustedAuthors(selected.values);
            verifiedAuthors = selected.verified;
            break;
          } catch (error) {
            output.write(`  Invalid trusted-author selection: ${String(error?.message ?? error)} Try again.\n`);
          }
        }

        const repositoryRecords = new Map(repositoryOptions.map((entry) => [entry.name.toLowerCase(), entry]));
        const authorRecords = new Map(authorOptions.map((entry) => [entry.id, entry]));
        if (authenticatedUser) authorRecords.set(authenticatedUser.id, authenticatedUser);
        for (const entry of verifiedAuthors) authorRecords.set(entry.id, entry);
        output.write('\nWARNING: These repositories will be polled for remote tasks. Each trusted actor can submit development work to this installation within its local capability policy.\n');
        output.write('Verified repository selection:\n');
        for (const repository of repositories) {
          const record = repositoryRecords.get(repository.toLowerCase());
          output.write(`  - ${repository}${record?.id ? ` [GitHub id ${record.id}]` : ' [existing local policy]'}\n`);
        }
        output.write('Verified trusted actor selection:\n');
        for (const id of trustedAuthors) {
          const record = authorRecords.get(id);
          output.write(`  - ${record?.login ? `${record.login} ` : ''}[GitHub actor id ${id}]\n`);
        }
        const confirmation = await prompt.question('Type APPLY to confirm these exact repository and task-author authority selections, or anything else to go back: ');
        if (String(confirmation).trim() === 'APPLY') {
          selections = {
            repositories,
            trustedAuthors,
            discovery: repositoryDiscovery,
            confirm: 'APPLY',
            supplied: true,
            verified: true,
          };
          break;
        }
        output.write('  Selections were not applied; returning to repository selection.\n');
      }
    } finally {
      prompt.close();
    }
  }

  if (selections.supplied && selections.verified !== true) {
    const repositoryRequested = selections.repositories.length > 0;
    const authorRequested = selections.trustedAuthors.length > 0;
    let verifiedAuthors = [];
    if (repositoryRequested) {
      const selected = await selectRepositories(selections.repositories.join(','), repositoryOptions, currentRepositories, {
        discovery,
        numericOptions: false,
      });
      selections.repositories = validateRepositorySelections(selected.values);
      repositoryOptions = mergeRepositoryOptions(repositoryOptions, selected.verified);
    }
    const authorRepositories = repositoryRequested ? selections.repositories : currentRepositories;
    if (authorRequested && discovery) {
      try {
        const observed = await discovery.listAuthors(authorRepositories);
        authorOptions = observed.records;
        authorWarnings = observed.warnings;
        authorOptionsTruncated = observed.truncated === true;
        authenticatedUser = observed.authenticatedUser ?? null;
      } catch (error) {
        authorWarnings = [{ repository: null, reason: String(error?.message ?? error).slice(0, 500) }];
      }
    }
    if (authorRequested) {
      const selected = await selectAuthors(selections.trustedAuthors.join(','), authorOptions, currentAuthors, {
        discovery,
        authenticatedUser,
        numericOptions: false,
      });
      selections.trustedAuthors = validateTrustedAuthors(selected.values);
      verifiedAuthors = selected.verified;
    }
    if (repositoryRequested || authorRequested) {
      const repositoryRecords = new Map(repositoryOptions.map((entry) => [entry.name.toLowerCase(), entry]));
      const authorRecords = new Map(authorOptions.map((entry) => [entry.id, entry]));
      if (authenticatedUser) authorRecords.set(authenticatedUser.id, authenticatedUser);
      for (const entry of verifiedAuthors) authorRecords.set(entry.id, entry);
      output.write('[devbridge-bootstrap] WARNING: repository selections grant polling scope and trusted actors can submit development work within local capability policy.\n');
      if (repositoryRequested) {
        for (const repository of selections.repositories) {
          const record = repositoryRecords.get(repository.toLowerCase());
          output.write(`[devbridge-bootstrap] verified-repository=${repository}${record?.id ? ` github-id=${record.id}` : ''}\n`);
        }
      }
      if (authorRequested) {
        for (const id of selections.trustedAuthors) {
          const record = authorRecords.get(id);
          output.write(`[devbridge-bootstrap] verified-trusted-actor=${id}${record?.login ? ` login=${record.login}` : ''}\n`);
        }
      }
      if (selections.confirm !== 'APPLY') {
        fail('Repository/task-author authority changes require exact --confirm APPLY after reviewing the warning and verified identities.');
      }
    }
    selections.verified = true;
  }

  if (!selections.supplied) {
    if (discovery && currentRepositories.length > 0) {
      try {
        const observed = await discovery.listAuthors(currentRepositories);
        authorOptions = observed.records;
        authorWarnings = observed.warnings;
        authorOptionsTruncated = observed.truncated === true;
      } catch (error) {
        authorWarnings = [{ repository: null, reason: String(error?.message ?? error).slice(0, 500) }];
      }
    }
    output.write(`${JSON.stringify({
      config: paths.config,
      repositories: currentRepositories,
      repositoryDiscovery: currentDiscovery,
      trustedTaskAuthorIds: currentAuthors,
      discoveredRepositories: repositoryOptions,
      repositoryOptionsTruncated,
      discoveredTaskAuthors: authorOptions,
      taskAuthorWarnings: authorWarnings,
      taskAuthorOptionsTruncated: authorOptionsTruncated,
      discoveryError: observedDiscoveryError,
      changed: false,
      hint: 'Use setup with repeated --repository and --trusted-author values, plus --repository-discovery or --no-repository-discovery.',
    }, null, 2)}\n`);
    return { changed: false, completed: false, repositories: currentRepositories, repositoryOptions };
  }

  const next = structuredClone(config);
  if (selections.repositories.length > 0) {
    next.github.queueRepositories = validateRepositorySelections(selections.repositories);
    next.workspace ??= {};
    const owners = new Map((next.workspace.allowedOwners ?? []).map((value) => [String(value).toLowerCase(), String(value)]));
    for (const repository of next.github.queueRepositories) {
      const owner = repository.split('/')[0];
      owners.set(owner.toLowerCase(), owner);
    }
    next.workspace.allowedOwners = [...owners.values()];
  }
  if (selections.trustedAuthors.length > 0) next.github.trustedActorIds = validateTrustedAuthors(selections.trustedAuthors);
  if (selections.discovery != null) {
    next.github.repositoryDiscovery = {
      ...(next.github.repositoryDiscovery ?? {}),
      enabled: selections.discovery,
    };
  }
  const backup = writeConfiguredLocalConfig(paths, original, next);
  output.write(`${JSON.stringify({
    config: paths.config,
    repositories: next.github.queueRepositories,
    repositoryDiscovery: next.github.repositoryDiscovery?.enabled === true,
    trustedTaskAuthorIds: next.github.trustedActorIds,
    changed: true,
    backup,
  }, null, 2)}\n`);
  return { changed: true, completed: true, backup, repositories: next.github.queueRepositories, repositoryOptions };
}

export function runDevBridgeCli(command, paths, runtime, runner = defaultRunner) {
  const result = runner(process.execPath, [runtime.cliPath, command, '--config', paths.config], {
    cwd: paths.runtime, env: process.env, stdio: 'inherit', shell: false, windowsHide: true,
  });
  if (result.error) fail(`Could not start DevBridge ${command}: ${result.error.message}`);
  return result.status ?? 1;
}

export function runDevBridgeCliCaptured(command, paths, runtime, runner = defaultRunner) {
  const result = runner(process.execPath, [runtime.cliPath, command, '--config', paths.config], {
    cwd: paths.runtime, env: process.env, stdio: 'pipe', shell: false, windowsHide: true,
  });
  if (result.error) fail(`Could not start DevBridge ${command}: ${result.error.message}`);
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

export function spawnDevBridgeDaemon(paths, runtime, spawnImpl = spawn) {
  return spawnImpl(process.execPath, [runtime.cliPath, 'daemon', '--config', paths.config], {
    cwd: paths.runtime,
    env: process.env,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
}

export function spawnBackgroundBootstrap(argv, paths, spawnImpl = spawn) {
  const launcher = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (!launcher || !existsSync(launcher)) fail('Headless start requires a local stage-0 launcher path.');
  const logs = path.join(paths.home, 'logs');
  const logFile = path.join(logs, 'supervisor.log');
  const previousLog = path.join(logs, 'supervisor.previous.log');
  mkdirSync(logs, { recursive: true });
  if (existsSync(logFile) && statSync(logFile).size > 4 * 1024 * 1024) renameSync(logFile, previousLog);
  const descriptor = openSync(logFile, 'a', 0o600);
  const childArgs = argv.filter((value) => value !== '--foreground');
  const commandIndex = childArgs.indexOf('start');
  if (commandIndex >= 0) childArgs[commandIndex] = 'daemon';
  else childArgs.unshift('daemon');
  const child = spawnImpl(process.execPath, [launcher, ...childArgs], {
    cwd: paths.home,
    env: process.env,
    detached: true,
    stdio: ['ignore', descriptor, descriptor],
    shell: false,
    windowsHide: true,
  });
  closeSync(descriptor);
  child.unref?.();
  return { pid: child.pid, logFile, previousLog };
}

export function readBackgroundLog(paths, { maxBytes = 64 * 1024 } = {}) {
  const file = path.join(paths.home, 'logs', 'supervisor.log');
  if (!existsSync(file)) return { file, text: '', available: false };
  const content = readFileSync(file);
  return { file, text: content.subarray(Math.max(0, content.length - maxBytes)).toString('utf8'), available: true };
}

export function syncInstalledLauncher(paths, runtime, {
  invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null,
} = {}) {
  const target = path.join(path.resolve(paths.home), 'bin', 'devbridge.mjs');
  if (invokedPath !== target) return { changed: false, reason: 'external-launcher' };
  const source = path.join(path.resolve(runtime.runtimeDir ?? paths.runtime), 'devbridge.mjs');
  if (!existsSync(source) || !statSync(source).isFile()) fail('Accepted runtime is missing its stage-0 launcher.');
  const next = readFileSync(source);
  if (existsSync(target) && readFileSync(target).equals(next)) return { changed: false, reason: 'current', path: target };
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, next, { mode: 0o700 });
  renameSync(temp, target);
  return { changed: true, reason: 'updated', path: target };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function decideSupervisorAction({ childExitCode, updatePending, operatorStopPending = false }) {
  if (operatorStopPending) return 'stop';
  if (updatePending) return 'update';
  if (childExitCode === 0) return 'stop';
  return 'restart';
}

export async function stopExistingDaemon(paths, runtime, runner = defaultRunner, {
  maxGraceAttempts = 2,
  stopCommandFn = () => runDevBridgeCliCaptured('stop', paths, runtime, runner),
  delayFn = delay,
} = {}) {
  for (let attempt = 1; attempt <= maxGraceAttempts; attempt += 1) {
    const result = stopCommandFn();
    if (result.status === 0) return { stopped: true };
    if (result.status !== 3) {
      const detail = (result.stderr || result.stdout).trim();
      fail(`Could not stop existing DevBridge daemon (exit ${result.status})${detail ? `: ${detail.slice(0, 2000)}` : ''}`);
    }
    if (attempt < maxGraceAttempts) {
      process.stdout.write(`[devbridge-supervisor] existing daemon is finishing an active cycle; cooperative stop attempt ${attempt}/${maxGraceAttempts}\n`);
      await delayFn(1000);
    }
  }
  fail('Existing DevBridge daemon did not stop at the cooperative boundary; refusing to terminate an unverified process.');
}
