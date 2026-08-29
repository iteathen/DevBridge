import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const MAX_CAPTURE = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const TRANSPORT_ENV_NAMES = Object.freeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);
const POSIX_ENV_NAMES = Object.freeze([
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
]);
const WINDOWS_ENV_NAMES = Object.freeze([
  'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
]);

function fail(message) { throw new Error(message); }

function reducedEnvironment(base, platform) {
  const environment = {};
  if (platform === 'win32') {
    const pathValue = base.Path ?? base.PATH ?? base.path;
    if (typeof pathValue === 'string') environment.Path = pathValue;
    for (const name of WINDOWS_ENV_NAMES) {
      if (typeof base[name] === 'string') environment[name] = base[name];
    }
  } else {
    for (const name of POSIX_ENV_NAMES) {
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

function normalizedEndpoint(value) {
  return String(value ?? '').trim().replace(/\/$/u, '').replace(/\.git$/u, '').toLowerCase();
}

export function createSourceChannel({ normalizeSelector, defaultEndpoint }) {
  if (typeof normalizeSelector !== 'function') throw new TypeError('normalizeSelector must be a function');
  if (typeof defaultEndpoint !== 'string' || defaultEndpoint.length < 1) throw new TypeError('defaultEndpoint must be non-empty text');

  function run(args, {
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
      env: reducedEnvironment(environment, process.platform),
      timeout: GIT_TIMEOUT_MS,
      shell: false,
      windowsHide: true,
    });
    if (result?.error || result?.status !== 0) fail(`git ${args[0] ?? 'operation'} failed`);
    return result;
  }

  function resolve(selector, {
    endpoint = defaultEndpoint,
    runner = defaultRunner,
    allowLocalSource = false,
    environment = process.env,
  } = {}) {
    const normalized = normalizeSelector(selector?.value ?? selector);
    if (normalized.kind === 'exact') {
      return Object.freeze({ head: normalized.value, fetchSpec: normalized.value, selector: normalized });
    }
    const remoteRef = `refs/heads/${normalized.value}`;
    const result = run(['ls-remote', '--exit-code', '--heads', endpoint, remoteRef], {
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

  function materialize(subject, destination, {
    endpoint = defaultEndpoint,
    runner = defaultRunner,
    allowLocalSource = false,
    environment = process.env,
  } = {}) {
    mkdirSync(destination, { mode: 0o700 });
    run(['init', '-q'], { cwd: destination, runner, allowLocalSource, environment });
    run(['remote', 'add', 'origin', endpoint], { cwd: destination, runner, allowLocalSource, environment });
    run(['fetch', '--no-tags', '--depth', '1', 'origin', subject.fetchSpec], {
      cwd: destination, runner, allowLocalSource, environment,
    });
    run(['checkout', '--detach', '-q', 'FETCH_HEAD'], {
      cwd: destination, runner, allowLocalSource, environment,
    });
    const head = String(run(['rev-parse', 'HEAD'], {
      cwd: destination, runner, allowLocalSource, environment,
    }).stdout ?? '').trim().toLowerCase();
    if (head !== subject.head) fail('Fetched source HEAD does not match the resolved exact subject.');
    const remote = String(run(['remote', 'get-url', 'origin'], {
      cwd: destination, runner, allowLocalSource, environment,
    }).stdout ?? '').trim();
    if (normalizedEndpoint(remote) !== normalizedEndpoint(endpoint)) {
      fail('Fetched source origin changed unexpectedly.');
    }
    const dirty = String(run(['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: destination, runner, allowLocalSource, environment,
    }).stdout ?? '').trim();
    if (dirty) fail('Fetched source is not clean.');
    return realpathSync.native(destination);
  }

  function acceptPrepared(subject, prepared) {
    if (prepared == null) return null;
    if (subject?.selector?.kind !== 'exact' || prepared?.head !== subject.head ||
        typeof prepared?.root !== 'string' || !path.isAbsolute(prepared.root)) {
      fail('Prepared source does not match the resolved exact subject.');
    }
    const info = lstatSync(prepared.root);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('Prepared source must be a real directory.');
    return realpathSync.native(prepared.root);
  }

  return Object.freeze({ acceptPrepared, resolve, materialize });
}
