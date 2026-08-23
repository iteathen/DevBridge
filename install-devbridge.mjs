#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const INSTALL_PROTOCOL = 'devbridge/entry-install-v1';
export const INSTALL_STATUS_PROTOCOL = 'devbridge/entry-install-status-v1';
export const INSTALL_LOCK_PROTOCOL = 'devbridge/entry-install-lock-v1';
export const SOURCE_REPOSITORY = 'https://github.com/iteathen/DevBridge.git';
export const INSTALLED_COMPONENT_FILES = Object.freeze([
  'devbridge-entry.mjs',
  'src/entry/content-addressed-runner-provider.mjs',
  'src/entry/development-stable-subject-authority.mjs',
  'src/entry/experimental-checkout-runner-provider.mjs',
  'src/entry/experimental-entry.mjs',
  'src/entry/experimental-subject-authority.mjs',
  'src/entry/github-runner-source.mjs',
  'src/entry/installation-identity.mjs',
  'src/entry/permanent-entry.mjs',
  'src/entry/production-stable-subject-authority.mjs',
  'src/entry/stable-entry.mjs',
  'src/entry/stable-runner-state.mjs',
]);

const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const EXACT_DIGEST = /^[0-9a-f]{64}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u;
const MAX_CAPTURE = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_LOCK_BYTES = 4096;
const TRANSPORT_ENV_NAMES = Object.freeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);
const POSIX_GIT_ENV_NAMES = Object.freeze([
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
]);
const WINDOWS_GIT_ENV_NAMES = Object.freeze([
  'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
]);

function fail(message) { throw new Error(message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function assertSupportedNode(version = process.versions.node) {
  const parts = String(version).split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length < 3 || parts.some((value) => !Number.isInteger(value))) {
    fail(`Could not parse Node.js version: ${version}`);
  }
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
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('Install ref is invalid.');
  }
  return Object.freeze({ kind: 'branch', value: ref });
}

export function parseInstallArgs(argv, { environment = process.env, homeDirectory = homedir() } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('installer argv must be an array');
  let home = environment.DEVBRIDGE_HOME ?? path.join(homeDirectory, '.devbridge');
  let selector = null;
  let help = false;
  let runSetup = true;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') { help = true; continue; }
    if (value === '--install-only') { runSetup = false; continue; }
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
    runSetup,
  });
}

function managedGitEnvironment(base = process.env, platform = process.platform) {
  const environment = {};
  if (platform === 'win32') {
    const pathValue = base.Path ?? base.PATH ?? base.path;
    if (typeof pathValue === 'string') environment.Path = pathValue;
    for (const name of WINDOWS_GIT_ENV_NAMES) {
      if (typeof base[name] === 'string') environment[name] = base[name];
    }
  } else {
    for (const name of POSIX_GIT_ENV_NAMES) {
      if (typeof base[name] === 'string') environment[name] = base[name];
    }
  }
  for (const name of TRANSPORT_ENV_NAMES) {
    if (typeof base[name] === 'string') environment[name] = base[name];
  }

  const nullConfig = platform === 'win32' ? 'NUL' : '/dev/null';
  environment.GIT_CONFIG_GLOBAL = nullConfig;
  environment.GIT_CONFIG_SYSTEM = nullConfig;
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
  if (result?.error || result?.status !== 0) {
    fail(`git ${args[0] ?? 'operation'} failed`);
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
  if (!EXACT_HEAD.test(String(head).toLowerCase()) || ref !== remoteRef) {
    fail('Install ref resolution returned an invalid subject.');
  }
  return Object.freeze({ head: head.toLowerCase(), fetchSpec: remoteRef, selector: normalized });
}

function ensureRealDirectory(candidate, name, { create = false, recursive = false } = {}) {
  if (create && !existsSync(candidate)) mkdirSync(candidate, { recursive, mode: 0o700 });
  const info = lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory.`);
  return realpathSync.native(candidate);
}

function ensureChildDirectory(parent, name) {
  const candidate = path.join(parent, name);
  if (!existsSync(candidate)) mkdirSync(candidate, { mode: 0o700 });
  return ensureRealDirectory(candidate, `Installer ${name} directory`);
}

function checkoutExact(subject, destination, {
  sourceRepository = SOURCE_REPOSITORY,
  runner = defaultRunner,
  allowLocalSource = false,
  environment = process.env,
} = {}) {
  mkdirSync(destination, { mode: 0o700 });
  runGit(['init', '-q'], { cwd: destination, runner, allowLocalSource, environment });
  runGit(['remote', 'add', 'origin', sourceRepository], { cwd: destination, runner, allowLocalSource, environment });
  runGit(['fetch', '--no-tags', '--depth', '1', 'origin', subject.fetchSpec], {
    cwd: destination, runner, allowLocalSource, environment,
  });
  runGit(['checkout', '--detach', '-q', 'FETCH_HEAD'], {
    cwd: destination, runner, allowLocalSource, environment,
  });

  const head = String(runGit(['rev-parse', 'HEAD'], {
    cwd: destination, runner, allowLocalSource, environment,
  }).stdout ?? '').trim().toLowerCase();
  if (head !== subject.head) fail('Fetched installer source HEAD does not match the resolved exact subject.');

  const remote = String(runGit(['remote', 'get-url', 'origin'], {
    cwd: destination, runner, allowLocalSource, environment,
  }).stdout ?? '').trim();
  if (normalizedRemote(remote) !== normalizedRemote(sourceRepository)) {
    fail('Fetched installer source origin changed unexpectedly.');
  }

  const dirty = String(runGit(['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: destination, runner, allowLocalSource, environment,
  }).stdout ?? '').trim();
  if (dirty) fail('Fetched installer source is not clean.');
}

function normalizeComponentPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 ||
      value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.includes(':')) {
    fail('Installed component manifest contains an unsafe path.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('Installed component manifest contains an unsafe path.');
  }
  return segments;
}

function readContainedRegularFile(root, relative, name) {
  const segments = normalizeComponentPath(relative);
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} parent is unsafe.`);
  }
  const candidate = path.join(root, ...segments);
  const info = lstatSync(candidate);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${name} must be a regular file.`);
  const actual = realpathSync.native(candidate);
  const relativeActual = path.relative(root, actual);
  if (relativeActual.startsWith('..') || path.isAbsolute(relativeActual)) fail(`${name} escaped its component root.`);
  return readFileSync(actual);
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
  return Object.freeze({
    protocol: INSTALL_PROTOCOL,
    head,
    sourceRepository: normalizedRemote(sourceRepository),
    files: INSTALLED_COMPONENT_FILES.map((relative) => {
      const bytes = readContainedRegularFile(root, relative, `Installed component ${relative}`);
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
    const canonicalRoot = realpathSync.native(root);

    const manifestPath = path.join(canonicalRoot, '.devbridge-entry-install.json');
    const manifestInfo = lstatSync(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() ||
        manifestInfo.size < 1 || manifestInfo.size > MAX_MANIFEST_BYTES) return false;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest?.protocol !== INSTALL_PROTOCOL || manifest.head !== expectedHead ||
        manifest.sourceRepository !== normalizedRemote(sourceRepository) ||
        !Array.isArray(manifest.files) || manifest.files.length !== INSTALLED_COMPONENT_FILES.length) {
      return false;
    }

    const expected = new Set(INSTALLED_COMPONENT_FILES);
    const listed = new Set();
    for (const record of manifest.files) {
      const segments = normalizeComponentPath(record?.path);
      const relative = segments.join('/');
      if (!expected.has(relative) || listed.has(relative) ||
          !Number.isSafeInteger(record?.bytes) || record.bytes < 0 ||
          !EXACT_DIGEST.test(String(record?.sha256 ?? '').toLowerCase())) {
        return false;
      }
      listed.add(relative);
      const bytes = readContainedRegularFile(canonicalRoot, relative, `Installed component ${relative}`);
      if (bytes.length !== record.bytes || digest(bytes) !== String(record.sha256).toLowerCase()) return false;
    }
    if (listed.size !== expected.size || [...expected].some((relative) => !listed.has(relative))) return false;

    const actual = walkFiles(canonicalRoot)
      .filter((relative) => relative !== '.devbridge-entry-install.json')
      .sort();
    const expectedSorted = [...expected].sort();
    return actual.length === expectedSorted.length &&
      actual.every((relative, index) => relative === expectedSorted[index]);
  } catch {
    return false;
  }
}

function copyComponent(checkout, destination) {
  mkdirSync(destination, { mode: 0o700 });
  for (const relative of INSTALLED_COMPONENT_FILES) {
    const bytes = readContainedRegularFile(checkout, relative, `Installer source ${relative}`);
    const segments = normalizeComponentPath(relative);
    let parent = destination;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
      else {
        const info = lstatSync(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) fail(`Installer destination for ${relative} is unsafe.`);
      }
    }
    writeFileSync(path.join(destination, ...segments), bytes, { mode: 0o600, flag: 'wx' });
  }
}

function preparedSourceRoot(subject, preparedSource) {
  if (preparedSource == null) return null;
  if (subject?.selector?.kind !== 'exact' || preparedSource?.head !== subject.head ||
      typeof preparedSource?.root !== 'string' || !path.isAbsolute(preparedSource.root)) {
    fail('Prepared installer source does not match the resolved exact subject.');
  }
  return ensureRealDirectory(preparedSource.root, 'Prepared installer source');
}

function safeExistingFile(candidate) {
  if (!existsSync(candidate)) return;
  const info = lstatSync(candidate);
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(`Refusing to replace unsafe installer target: ${path.basename(candidate)}`);
  }
}

function processIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function readInstallLock(lockPath) {
  const info = lstatSync(lockPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_LOCK_BYTES) {
    fail('Installer lock state is invalid.');
  }
  const record = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (record?.protocol !== INSTALL_LOCK_PROTOCOL ||
      !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      typeof record.token !== 'string' || !/^[0-9a-f-]{36}$/u.test(record.token) ||
      !Number.isSafeInteger(record.startedAt) || record.startedAt <= 0) {
    fail('Installer lock state is invalid.');
  }
  return { info, record };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function acquireInstallLock(entryRoot) {
  const lockPath = path.join(entryRoot, '.install.lock');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomUUID();
    const temporary = path.join(entryRoot, `.install-lock-${process.pid}-${token}.tmp`);
    const record = Object.freeze({
      protocol: INSTALL_LOCK_PROTOCOL,
      pid: process.pid,
      startedAt: Date.now(),
      token,
    });
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      linkSync(temporary, lockPath);
      unlinkSync(temporary);
      return () => {
        try {
          const current = readInstallLock(lockPath);
          if (current.record.token === token && current.record.pid === process.pid) unlinkSync(lockPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            // Lock cleanup is deliberately non-authoritative after installation.
          }
        }
      };
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      if (error?.code !== 'EEXIST') throw error;
    }

    let occupied;
    try { occupied = readInstallLock(lockPath); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (processIsLive(occupied.record.pid)) fail('Another DevBridge installer is active for this installation.');

    let current;
    try { current = lstatSync(lockPath); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!sameFileIdentity(occupied.info, current)) continue;
    unlinkSync(lockPath);
  }
  fail('Could not acquire the DevBridge installer lock safely.');
}

function quarantineInvalidComponent(target, quarantineRoot, head) {
  if (!existsSync(target)) return null;
  const destination = path.join(quarantineRoot, `${head.slice(0, 12)}-${randomUUID()}`);
  renameSync(target, destination);
  return destination;
}

function stageFile(target, content, mode) {
  const next = `${target}.next-${process.pid}-${randomUUID()}`;
  writeFileSync(next, content, { mode, flag: 'wx' });
  if (mode & 0o111) chmodSync(next, mode);
  return Object.freeze({ target, next });
}

function publishStagedFile(staged) {
  renameSync(staged.next, staged.target);
}

function cleanupStagedFile(staged) {
  try { rmSync(staged.next, { force: true }); } catch {}
}

function javascriptWrapper(home, componentHead, pinnedRunnerHead) {
  const pin = pinnedRunnerHead == null ? 'null' : JSON.stringify(pinnedRunnerHead);
  return `#!/usr/bin/env node
import process from 'node:process';
const home = ${JSON.stringify(home)};
const componentHead = '${componentHead}';
const componentUrl = new URL('../entry/components/${componentHead}/devbridge-entry.mjs', import.meta.url).href;
const pinned = ${pin};
const argv = [...process.argv.slice(2)];
if (argv[0] === 'entry-install-status') {
  if (argv.length !== 1) throw new Error('entry-install-status accepts no additional arguments');
  process.stdout.write(JSON.stringify({ protocol: '${INSTALL_STATUS_PROTOCOL}', home, componentHead, pinnedRunnerHead: pinned }) + '\\n');
} else {
  const hasHome = argv.some((value) => value === '--home');
  const hasSelector = argv.some((value) => value === '--ref' || value === '--branch');
  if (!hasHome) argv.push('--home', home);
  if (pinned && !hasSelector) argv.unshift('--ref', pinned);
  try {
    const module = await import(componentUrl);
    if (typeof module?.runInstalledEntry !== 'function') throw new Error('installed permanent entry is unavailable');
    const status = await module.runInstalledEntry(argv);
    if (Number.isInteger(status)) process.exitCode = status;
  } catch (error) {
    process.stderr.write('[devbridge-entry] ' + String(error?.message ?? error) + '\\n');
    process.exitCode = 1;
  }
}
`;
}

function installWrappers(home, componentHead, pinnedRunnerHead) {
  const bin = ensureChildDirectory(home, 'bin');
  const javascript = path.join(bin, 'devbridge-entry.mjs');
  const previous = path.join(bin, 'devbridge-entry.previous.mjs');
  const command = path.join(bin, 'devbridge-entry.cmd');
  const shell = path.join(bin, 'devbridge-entry');

  for (const candidate of [javascript, previous, command, shell]) safeExistingFile(candidate);

  const previousBytes = existsSync(javascript) ? readFileSync(javascript) : null;
  const staged = [];
  try {
    if (previousBytes != null) staged.push({ role: 'previous', file: stageFile(previous, previousBytes, 0o700) });
    staged.push({
      role: 'command',
      file: stageFile(command, '@echo off\r\nnode "%~dp0devbridge-entry.mjs" %*\r\n', 0o700),
    });
    staged.push({
      role: 'shell',
      file: stageFile(shell, '#!/bin/sh\nexec node "$(dirname "$0")/devbridge-entry.mjs" "$@"\n', 0o700),
    });
    staged.push({
      role: 'javascript',
      file: stageFile(javascript, javascriptWrapper(home, componentHead, pinnedRunnerHead), 0o700),
    });

    for (const role of ['previous', 'command', 'shell']) {
      const item = staged.find((entry) => entry.role === role);
      if (item) publishStagedFile(item.file);
    }
    publishStagedFile(staged.find((entry) => entry.role === 'javascript').file);
  } catch (error) {
    for (const entry of staged) cleanupStagedFile(entry.file);
    throw error;
  }

  return Object.freeze({ javascript, command, shell });
}

export function installDevBridge(options, {
  sourceRepository = SOURCE_REPOSITORY,
  runner = defaultRunner,
  allowLocalSource = false,
  environment = process.env,
  preparedSource = null,
} = {}) {
  assertSupportedNode();

  const requestedHome = path.resolve(String(options?.home ?? path.join(homedir(), '.devbridge')));
  if (!existsSync(requestedHome)) mkdirSync(requestedHome, { recursive: true, mode: 0o700 });
  const home = ensureRealDirectory(requestedHome, 'DevBridge installation home');
  const entryRoot = ensureChildDirectory(home, 'entry');
  const releaseLock = acquireInstallLock(entryRoot);

  try {
    const selector = normalizeInstallRef(options?.selector?.value ?? options?.selector ?? 'main');
    const pinSelectedRunner = options?.pinSelectedRunner === true;
    const subject = resolveInstallSubject(selector, {
      sourceRepository, runner, allowLocalSource, environment,
    });
    const preparedRoot = preparedSourceRoot(subject, preparedSource);

    const components = ensureChildDirectory(entryRoot, 'components');
    const staging = ensureChildDirectory(entryRoot, 'staging');
    const quarantine = ensureChildDirectory(entryRoot, 'quarantine');
    const target = path.join(components, subject.head);

    if (!verifyInstalledComponent(target, subject.head, sourceRepository)) {
      quarantineInvalidComponent(target, quarantine, subject.head);
      const work = mkdtempSync(path.join(staging, `${subject.head.slice(0, 12)}-`));
      try {
        const component = path.join(work, 'component');
        let source = preparedRoot;
        if (source == null) {
          const checkout = path.join(work, 'source');
          checkoutExact(subject, checkout, {
            sourceRepository, runner, allowLocalSource, environment,
          });
          source = realpathSync.native(checkout);
        }
        copyComponent(source, component);
        writeComponentManifest(component, componentManifest(component, subject.head, sourceRepository));
        if (!verifyInstalledComponent(component, subject.head, sourceRepository)) {
          fail('Staged permanent-entry component failed self-verification.');
        }

        try {
          renameSync(component, target);
        } catch (error) {
          if (!existsSync(target) || !verifyInstalledComponent(target, subject.head, sourceRepository)) throw error;
        }
      } finally {
        try { rmSync(work, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); } catch {}
      }
    }

    if (!verifyInstalledComponent(target, subject.head, sourceRepository)) {
      fail('Installed permanent-entry component failed verification.');
    }

    const wrappers = installWrappers(home, subject.head, pinSelectedRunner ? subject.head : null);
    return Object.freeze({
      protocol: INSTALL_PROTOCOL,
      home,
      componentHead: subject.head,
      pinnedRunnerHead: pinSelectedRunner ? subject.head : null,
      wrappers,
    });
  } finally {
    releaseLock();
  }
}

export function runInstalledSetup(installed, {
  runner = defaultRunner,
  environment = process.env,
} = {}) {
  const launcher = installed?.wrappers?.javascript;
  if (typeof installed?.home !== 'string' || !path.isAbsolute(installed.home) || typeof launcher !== 'string' || !path.isAbsolute(launcher)) {
    throw new TypeError('installed setup handoff requires one exact installed DevBridge launcher');
  }
  const result = runner(process.execPath, [launcher, 'setup'], {
    cwd: installed.home,
    env: environment,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
  if (result?.error) fail(`Could not enter DevBridge setup: ${result.error.message}`);
  if (!Number.isInteger(result?.status)) fail('DevBridge setup exited without a bounded status code');
  return result.status;
}

export function installHelp() {
  return `DevBridge permanent-entry installer

Usage:
  node install-devbridge.mjs [--home <path>]
  node install-devbridge.mjs --ref <branch-or-exact-head> [--home <path>]
  node install-devbridge.mjs --install-only [--ref <branch-or-exact-head>] [--home <path>]

By default the installer establishes the permanent entry and immediately enters the installed runner's public DevBridge setup path.
No selector installs the permanent entry from the exact current main head and leaves normal stable runner selection active.
An explicit --ref/--branch is local qualification authority: it is resolved once and the generated entry wrapper pins that exact runner head by default.
--install-only stops after permanent-entry installation for explicit qualification/recovery work.
The installer writes devbridge-entry.* beside any existing devbridge.mjs Stage-0 launcher; it does not overwrite Stage 0.
`;
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const args = parseInstallArgs(process.argv.slice(2));
    if (args.help) process.stdout.write(installHelp());
    else {
      const installed = installDevBridge(args);
      if (args.runSetup) process.exitCode = runInstalledSetup(installed);
      else process.stdout.write(`${JSON.stringify(installed)}\n`);
    }
  } catch (error) {
    process.stderr.write(`[devbridge-installer] ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
