import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { SOURCE_BUNDLE_REF } from '../bootstrap/source-bundle-release-input.mjs';
import { sameFilesystemIdentity } from '../runtime/local-filesystem-identity.js';

const SOURCE_REPOSITORY = 'https://github.com/iteathen/DevBridge.git';
const OBJECT_FORMAT = /^[a-f0-9]{40}$/u;
const MAX_CAPTURE = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

function fail(message) { throw new Error(message); }

function reducedEnvironment(base = process.env) {
  const names = process.platform === 'win32'
    ? ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)']
    : ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];
  const environment = {};
  for (const name of names) if (typeof base[name] === 'string') environment[name] = base[name];
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  environment.GIT_CONFIG_GLOBAL = nullConfig;
  environment.GIT_CONFIG_SYSTEM = nullConfig;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GCM_INTERACTIVE = 'Never';
  return environment;
}

function defaultRun(executable, args, options) {
  return spawnSync(executable, args, {
    ...options,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: MAX_CAPTURE,
  });
}

async function absent(location) {
  try { await lstat(location); return false; }
  catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

function resultText(result) { return String(result?.stdout ?? '').trim(); }

export class GitSourceBundleProducer {
  #run;

  constructor({ run = defaultRun } = {}) {
    if (typeof run !== 'function') throw new TypeError('source-bundle Git command port is invalid');
    this.#run = run;
  }

  #git(args, { cwd, allowFile = false, signal = null } = {}) {
    const result = this.#run('git', [
      '-c', 'credential.helper=',
      '-c', 'core.hooksPath=',
      '-c', 'protocol.ext.allow=never',
      '-c', `protocol.file.allow=${allowFile ? 'always' : 'never'}`,
      ...args,
    ], {
      cwd,
      env: reducedEnvironment(),
      timeout: GIT_TIMEOUT_MS,
      signal: signal ?? undefined,
      shell: false,
      windowsHide: true,
    });
    if (result?.error || result?.status !== 0) fail(`source-bundle Git ${args[0] ?? 'operation'} failed`);
    return result;
  }

  #observe(repository, signal) {
    const origin = resultText(this.#git(['remote', 'get-url', 'origin'], { cwd: repository, signal }));
    if (origin !== SOURCE_REPOSITORY) fail('source-bundle repository origin is not canonical DevBridge');
    const head = resultText(this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: repository, signal })).toLowerCase();
    const tree = resultText(this.#git(['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: repository, signal })).toLowerCase();
    if (!OBJECT_FORMAT.test(head) || !OBJECT_FORMAT.test(tree)) fail('source-bundle repository identity is invalid');
    if (resultText(this.#git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repository, signal })) !== '') {
      fail('source-bundle repository must be clean');
    }
    return Object.freeze({ head, tree });
  }

  async create({ repository, destination, head, signal = null } = {}) {
    const selectedHead = String(head ?? '').toLowerCase();
    if (!OBJECT_FORMAT.test(selectedHead)) throw new TypeError('source-bundle release head is invalid');
    if (typeof repository !== 'string' || !path.isAbsolute(repository) || repository.includes('\0')) {
      throw new TypeError('source-bundle release repository is invalid');
    }
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) {
      throw new TypeError('source-bundle release destination is invalid');
    }
    if (signal != null && typeof signal !== 'object') throw new TypeError('source-bundle release signal is invalid');
    if (signal?.aborted) throw signal.reason ?? new Error('source-bundle release was interrupted');
    const source = path.resolve(repository);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()
        || !await sameFilesystemIdentity(await realpath(source), source)) {
      fail('source-bundle release repository must be a real canonical directory');
    }
    if (!await absent(destination)) fail('source-bundle release destination already exists');
    const before = this.#observe(source, signal);
    if (before.head !== selectedHead) fail('source-bundle release head does not match repository HEAD');

    const operation = path.join(path.dirname(destination), `.source-bundle-git-${randomUUID()}`);
    const producer = path.join(operation, 'producer.git');
    const verifier = path.join(operation, 'verifier.git');
    await mkdir(operation, { mode: 0o700 });
    try {
      this.#git(['init', '--bare', '--quiet', producer], { cwd: operation, signal });
      this.#git(['-C', producer, 'fetch', '--no-auto-maintenance', '--no-tags', '--force', source, `HEAD:${SOURCE_BUNDLE_REF}`], {
        cwd: operation,
        allowFile: true,
        signal,
      });
      if (resultText(this.#git(['-C', producer, 'rev-parse', '--verify', SOURCE_BUNDLE_REF], { cwd: operation, signal })).toLowerCase() !== selectedHead) {
        fail('source-bundle producer fetched a different head');
      }
      this.#git(['-C', producer, 'bundle', 'create', '--version=2', destination, SOURCE_BUNDLE_REF], { cwd: operation, signal });

      this.#git(['init', '--bare', '--quiet', verifier], { cwd: operation, signal });
      this.#git(['-C', verifier, 'bundle', 'verify', destination], { cwd: operation, allowFile: true, signal });
      const heads = resultText(this.#git(['-C', verifier, 'bundle', 'list-heads', destination], {
        cwd: operation,
        allowFile: true,
        signal,
      })).split(/\r?\n/u).filter(Boolean);
      if (heads.length !== 1 || heads[0] !== `${selectedHead} ${SOURCE_BUNDLE_REF}`) {
        fail('source-bundle producer advertised an unexpected ref');
      }
      this.#git(['-C', verifier, 'fetch', '--no-auto-maintenance', '--no-tags', destination, SOURCE_BUNDLE_REF], {
        cwd: operation,
        allowFile: true,
        signal,
      });
      if (resultText(this.#git(['-C', verifier, 'rev-parse', '--verify', 'FETCH_HEAD'], { cwd: operation, signal })).toLowerCase() !== selectedHead
          || resultText(this.#git(['-C', verifier, 'rev-parse', '--verify', 'FETCH_HEAD^{tree}'], { cwd: operation, signal })).toLowerCase() !== before.tree) {
        fail('source-bundle producer verification does not match the exact source');
      }
      const bundle = await lstat(destination);
      if (!bundle.isFile() || bundle.isSymbolicLink() || bundle.nlink !== 1 || bundle.size < 1) {
        fail('source-bundle producer output is invalid');
      }
      const after = this.#observe(source, signal);
      if (after.head !== before.head || after.tree !== before.tree) fail('source-bundle repository changed during release production');
      return Object.freeze({ head: selectedHead, tree: before.tree, location: path.resolve(destination), size: bundle.size });
    } catch (error) {
      await rm(destination, { force: true }).catch(() => {});
      throw error;
    } finally {
      await rm(operation, { recursive: true, force: true }).catch(() => {});
    }
  }
}
