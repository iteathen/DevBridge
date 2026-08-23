#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const INSTALL_PROTOCOL = 'devbridge/entry-install-v1';
export const INSTALL_STATUS_PROTOCOL = 'devbridge/entry-install-status-v1';
export const SOURCE_REPOSITORY = 'https://github.com/iteathen/DevBridge.git';
const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u;
const MAX_CAPTURE = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const COMPONENT_FILES = Object.freeze(['devbridge-entry.mjs', 'src/entry']);
const SCRUBBED_GIT_ENVIRONMENT = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ASKPASS', 'GIT_CONFIG', 'GIT_CONFIG_COUNT',
  'GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_WORK_TREE',
  'SSH_ASKPASS', 'SSH_AUTH_SOCK',
]);

function fail(message) { throw new Error(message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function assertSupportedNode(version = process.versions.node) {
  const parts = String(version).split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length < 3 || parts.some((value) => !Number.isInteger(value))) fail(`Could not parse Node.js version: ${version}`);
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parts[index] > MINIMUM_NODE[index]) return;
    if (parts[index] < MINIMUM_NODE[index]) fail('DevBridge requires Node.js 22.16.0 or newer.');
  }
}

function expandHome(value, homeDirectory = homedir()) {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDirectory, value.slice(2));
  return value;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || !value || value.startsWith('-')) fail(`${flag} requires a value`);
  return value;
}

export function normalizeInstallRef(value) {
  const ref = String(value ?? '');
  const exact = ref.toLowerCase();
  if (EXACT_HEAD.test(exact)) return Object.freeze({ kind: 'exact', value: exact });
  const segments = ref.split('/');
  if (!SAFE_REF.test(ref) || ref.startsWith('-') || ref.includes('\\') || ref.endsWith('/') || ref.endsWith('.lock') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')) fail('Install ref is invalid.');
  return Object.freeze({ kind: 'branch', value: ref });
}

export function parseInstallArgs(argv, { environment = process.env, homeDirectory = homedir() } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('installer argv must be an array');
  let home = environment.DEVBRIDGE_HOME ?? path.join(homeDirectory, '.devbridge');
  let selector = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') { help = true; continue; }
    if (value === '--home') {
      home = takeValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === '--ref' || value === '--branch') {
      if (selector != null) fail('Only one installer ref/branch selector may be supplied.');
      selector = normalizeInstallRef(takeValue(argv, index, value));
      index += 1;
      continue;
    }
    fail(`Unsupported installer argument: ${value}`);
  }
  return Object.freeze({
    help,
    home: path.resolve(expandHome(String(home), homeDirectory)),
    selector: selector ?? Object.freeze({ kind: 'branch', value: 'main' }),
    pinSelectedRunner: selector != null,
  });
}

function managedGitEnvironment(base = process.env, platform = process.platform) {
  const environment = { ...base };
  for (const name of SCRUBBED_GIT_ENVIRONMENT) delete environment[name];
  if (platform === 'win32') {
    const pathValue = base.Path ?? base.PATH ?? base.path;
    for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key];
    if (pathValue != null) environment.Path = pathValue;
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GCM_INTERACTIVE = 'Never';
  return environment;
}

function defaultRunner(executable, args, options) {
  return spawnSync(executable, args, {
    ...options,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_CAPTURE,
  });
}

function runGit(args, {
  cwd = undefined,
  runner = defaultRunner,
  allowLocalSource = false,
  environment = process.env,
} = {}) {
  const fullArgs = [
    '-c', 'credential.helper=',
    '-c', 'protocol.ext.allow=never',
    '-c', `protocol.file.allow=${allowLocalSource ? 'always' : 'never'}`,
    ...args,
  ];
  const result = runner('git', fullArgs, {
    cwd,
    env: managedGitEnvironment(environment),
    timeout: GIT_TIMEOUT_MS,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 2000);
    fail(`git ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function normalizedRemote(value) {
  return String(value ?? '').trim().replace(/\/$/u, '').replace(/\.git$/u, '').toLowerCase();
}

export function resolveInstallSubject(selector, {
  sourceRepository = SOURCE_REPOSITORY,
  runner = defaultRunner,
  allowLocalSource = false,
  environment = process.env,
} = {}) {
  const normalized = normalizeInstallRef(selector?.value ?? selector);
  if (normalized.kind === 'exact') {
    return Object.freeze({ head: normalized.value, fetchSpec: normalized.value, selector: normalized });
  }
  const remoteRef = `refs/heads/${normalized.value}`;
  const result = runGit(['ls-remote', '--exit-code', '--heads', sourceRepository, remoteRef], {
    runner, allowLocalSource, environment,
  });
  const records = String(result.stdout ?? '').trim().split(/\r?\n/u).filter(Boolean);
  if (records.length !== 1) fail('Install ref did not resolve to exactly one branch head.');
  const [head, ref] = records[0].trim().split(/\s+/u);
  if (!EXACT_HEAD.test(String(head).toLowerCase()) || ref !== remoteRef) fail('Install ref resolution returned an invalid subject.');
  return Object.freeze({ head: head.toLowerCase(), fetchSpec: remoteRef, selector: normalized });
}

function checkoutExact(subject, destination, {
  sourceRepository = SOURCE_REPOSITORY,
  runner = defaultRunner,
  allowLocalSource = false,
  environment = process.env,
} = {}) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  runGit(['init', '-q'], { cwd: destination, runner, allowLocalSource, environment });
  runGit(['remote', 'add', 'origin', sourceRepository], { cwd: destination, runner, allowLocalSource, environment });
  runGit(['fetch', '--no-tags', '--depth', '1', 'origin', subject.fetchSpec], { cwd: destination, runner, allowLocalSource, environment });
  runGit(['checkout', '--detach', '-q', 'FETCH_HEAD'], { cwd: destination, runner, allowLocalSource, environment });
  const head = String(runGit(['rev-parse', 'HEAD'], { cwd: destination, runner, allowLocalSource, environment }).stdout ?? '').trim().toLowerCase();
  if (head !== subject.head) fail('Fetched installer source HEAD does not match the resolved exact subject.');
  const remote = String(runGit(['remote', 'get-url', 'origin'], { cwd: destination, runner, allowLocalSource, environment }).stdout ?? '').trim();
  if (normalizedRemote(remote) !== normalizedRemote(sourceRepository)) fail('Fetched installer source origin changed unexpectedly.');
  const dirty = String(runGit(['status', '--porcelain'], { cwd: destination, runner, allowLocalSource, environment }).stdout ?? '').trim();
  if (dirty) fail('Fetched installer source is not clean.');
}

function walkFiles(root, current = root, result = []) {
  for (const name of readdirSync(current).sort()) {
    const candidate = path.join(current, name);
    const info = lstatSync(candidate);
    if (info.isSymbolicLink()) fail('Entry component contains a symbolic link.');
    if (info.isDirectory()) walkFiles(root, candidate, result);
    else if (info.isFile()) result.push(path.relative(root, candidate).split(path.sep).join('/'));
    else fail('Entry component contains an unsupported filesystem object.');
  }
  return result;
}

function componentManifest(root, head, sourceRepository) {
  const files = walkFiles(root).filter((relative) => relative !== '.devbridge-entry-install.json').sort();
  return Object.freeze({
    protocol: INSTALL_PROTOCOL,
    head,
    sourceRepository: normalizedRemote(sourceRepository),
    files: files.map((relative) => {
      const bytes = readFileSync(path.join(root, ...relative.split('/')));
      return Object.freeze({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
    }),
  });
}

function writeComponentManifest(root, manifest) {
  writeFileSync(path.join(root, '.devbridge-entry-install.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
}

export function verifyInstalledComponent(root, expectedHead, sourceRepository = SOURCE_REPOSITORY) {
  try {
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const manifestPath = path.join(root, '.devbridge-entry-install.json');
    const manifestInfo = lstatSync(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest?.protocol !== INSTALL_PROTOCOL || manifest.head !== expectedHead ||
        manifest.sourceRepository !== normalizedRemote(sourceRepository) || !Array.isArray(manifest.files) || manifest.files.length < 2) return false;
    const listed = new Set();
    for (const record of manifest.files) {
      const segments = typeof record?.path === 'string' ? record.path.split('/') : [];
      if (segments.length < 1 || segments.some((segment) => !segment || segment === '.' || segment === '..') || listed.has(record.path)) return false;
      listed.add(record.path);
      const file = path.join(root, ...segments);
      const fileInfo = lstatSync(file);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) return false;
      const bytes = readFileSync(file);
      if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) return false;
    }
    const actual = walkFiles(root).filter((relative) => relative !== '.devbridge-entry-install.json').sort();
    if (actual.length !== listed.size || actual.some((relative) => !listed.has(relative))) return false;
    return listed.has('devbridge-entry.mjs') && [...listed].some((relative) => relative.startsWith('src/entry/'));
  } catch {
    return false;
  }
}

function copyComponent(checkout, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const relative of COMPONENT_FILES) {
    const source = path.join(checkout, ...relative.split('/'));
    if (!existsSync(source)) fail(`Installer source is missing ${relative}.`);
    const info = lstatSync(source);
    if (info.isSymbolicLink()) fail(`Installer source ${relative} must not be a symbolic link.`);
    const target = path.join(destination, ...relative.split('/'));
    if (info.isDirectory()) cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true });
    else if (info.isFile()) { mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(source, target); }
    else fail(`Installer source ${relative} has an unsupported type.`);
  }
}

function safeExistingFile(candidate) {
  if (!existsSync(candidate)) return;
  const info = lstatSync(candidate);
  if (!info.isFile() || info.isSymbolicLink()) fail(`Refusing to replace unsafe installer target: ${path.basename(candidate)}`);
}

function atomicReplaceText(target, content, { mode = 0o600, previous = null } = {}) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  safeExistingFile(target);
  if (previous) safeExistingFile(previous);
  const next = `${target}.next-${process.pid}`;
  const old = `${target}.old-${process.pid}`;
  writeFileSync(next, content, { encoding: 'utf8', mode, flag: 'wx' });
  let movedOld = false;
  try {
    if (existsSync(target)) { renameSync(target, old); movedOld = true; }
    renameSync(next, target);
    if (movedOld && previous) copyFileSync(old, previous);
    if (movedOld) rmSync(old, { force: true });
  } catch (error) {
    if (existsSync(next)) rmSync(next, { force: true });
    if (movedOld && !existsSync(target) && existsSync(old)) renameSync(old, target);
    throw error;
  }
  if (mode & 0o111) chmodSync(target, mode);
}

function javascriptWrapper(home, componentHead, pinnedRunnerHead) {
  const pin = pinnedRunnerHead == null ? 'null' : JSON.stringify(pinnedRunnerHead);
  return `#!/usr/bin/env node\nimport process from 'node:process';\nimport { runInstalledEntry } from '../entry/components/${componentHead}/devbridge-entry.mjs';\nconst home = ${JSON.stringify(home)};\nconst pinned = ${pin};\nconst argv = [...process.argv.slice(2)];\nif (argv[0] === 'entry-install-status') {\n  process.stdout.write(JSON.stringify({ protocol: '${INSTALL_STATUS_PROTOCOL}', home, componentHead: '${componentHead}', pinnedRunnerHead: pinned }) + '\\n');\n} else {\n  const hasHome = argv.some((value) => value === '--home');\n  const hasSelector = argv.some((value) => value === '--ref' || value === '--branch');\n  if (!hasHome) argv.push('--home', home);\n  if (pinned && !hasSelector) argv.unshift('--ref', pinned);\n  try {\n    const status = await runInstalledEntry(argv);\n    if (Number.isInteger(status)) process.exitCode = status;\n  } catch (error) {\n    process.stderr.write('[devbridge-entry] ' + String(error?.message ?? error) + '\\n');\n    process.exitCode = 1;\n  }\n}\n`;
}

function installWrappers(home, componentHead, pinnedRunnerHead) {
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const javascript = path.join(bin, 'devbridge-entry.mjs');
  atomicReplaceText(javascript, javascriptWrapper(home, componentHead, pinnedRunnerHead), {
    mode: 0o700,
    previous: path.join(bin, 'devbridge-entry.previous.mjs'),
  });
  const command = path.join(bin, 'devbridge-entry.cmd');
  atomicReplaceText(command, '@echo off\r\nnode "%~dp0devbridge-entry.mjs" %*\r\n', { mode: 0o700 });
  const shell = path.join(bin, 'devbridge-entry');
  atomicReplaceText(shell, '#!/bin/sh\nexec node "$(dirname "$0")/devbridge-entry.mjs" "$@"\n', { mode: 0o700 });
  return Object.freeze({ javascript, command, shell });
}

export function installDevBridge(options, {
  sourceRepository = SOURCE_REPOSITORY,
  runner = defaultRunner,
  allowLocalSource = false,
  environment = process.env,
} = {}) {
  assertSupportedNode();
  const home = path.resolve(String(options?.home ?? path.join(homedir(), '.devbridge')));
  const selector = normalizeInstallRef(options?.selector?.value ?? options?.selector ?? 'main');
  const pinSelectedRunner = options?.pinSelectedRunner === true;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const subject = resolveInstallSubject(selector, { sourceRepository, runner, allowLocalSource, environment });
  const components = path.join(home, 'entry', 'components');
  const staging = path.join(home, 'entry', 'staging');
  mkdirSync(components, { recursive: true, mode: 0o700 });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const target = path.join(components, subject.head);

  if (!verifyInstalledComponent(target, subject.head, sourceRepository)) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    const work = mkdtempSync(path.join(staging, `${subject.head.slice(0, 12)}-`));
    try {
      const checkout = path.join(work, 'source');
      const component = path.join(work, 'component');
      checkoutExact(subject, checkout, { sourceRepository, runner, allowLocalSource, environment });
      copyComponent(checkout, component);
      writeComponentManifest(component, componentManifest(component, subject.head, sourceRepository));
      if (!verifyInstalledComponent(component, subject.head, sourceRepository)) fail('Staged permanent-entry component failed self-verification.');
      renameSync(component, target);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  if (!verifyInstalledComponent(target, subject.head, sourceRepository)) fail('Installed permanent-entry component failed verification.');
  const wrappers = installWrappers(home, subject.head, pinSelectedRunner ? subject.head : null);
  return Object.freeze({
    protocol: INSTALL_PROTOCOL,
    home: realpathSync.native(home),
    componentHead: subject.head,
    pinnedRunnerHead: pinSelectedRunner ? subject.head : null,
    wrappers,
  });
}

export function installHelp() {
  return `DevBridge permanent-entry installer\n\nUsage:\n  node install-devbridge.mjs [--home <path>]\n  node install-devbridge.mjs --ref <branch-or-exact-head> [--home <path>]\n\nNo selector installs the permanent entry from the exact current main head and leaves normal stable runner selection active.\nAn explicit --ref/--branch is local qualification authority: it is resolved once and the generated entry wrapper pins that exact runner head by default.\nThe installer writes devbridge-entry.* beside any existing devbridge.mjs Stage-0 launcher; it does not overwrite Stage 0.\n`;
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const args = parseInstallArgs(process.argv.slice(2));
    if (args.help) process.stdout.write(installHelp());
    else process.stdout.write(`${JSON.stringify(installDevBridge(args))}\n`);
  } catch (error) {
    process.stderr.write(`[devbridge-installer] ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
