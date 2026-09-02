import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { sameObservedFilesystemIdentity } from '../runtime/local-filesystem-identity.js';
import { SOURCE_BUNDLE_REF } from './source-bundle-release-input.mjs';

export { SOURCE_BUNDLE_REF };

const SOURCE_REPOSITORY = 'https://github.com/iteathen/DevBridge.git';
const OBJECT_FORMAT = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_CAPTURE = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

function fail(message) { throw new Error(message); }

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

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

async function verifyBundleFile(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
      || typeof bundle.location !== 'string' || !path.isAbsolute(bundle.location)
      || !Number.isSafeInteger(bundle.size) || bundle.size < 1 || !DIGEST.test(String(bundle.sha256 ?? ''))) {
    throw new TypeError('Git bundle object is invalid');
  }
  const before = await lstat(bundle.location, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(bundle.size)) {
    fail('Git bundle object shape does not match authority');
  }
  const handle = await open(bundle.location, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) fail('Git bundle object changed while opening');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let offset = 0;
    while (offset < bundle.size) {
      const requested = Math.min(buffer.length, bundle.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead !== requested) fail('Git bundle object ended while reading');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await lstat(bundle.location, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(held, after)) fail('Git bundle object changed while reading');
    if (hash.digest('hex') !== bundle.sha256) fail('Git bundle object digest does not match authority');
    return before;
  } finally { await handle.close(); }
}

async function absent(location) {
  try { await lstat(location); return false; }
  catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

function resultText(result) { return String(result?.stdout ?? '').trim(); }

export class GitBundleCheckout {
  #run;

  constructor({ run = defaultRun } = {}) {
    if (typeof run !== 'function') throw new TypeError('Git bundle command port is invalid');
    this.#run = run;
  }

  #git(args, { cwd, allowFile = false } = {}) {
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
      shell: false,
      windowsHide: true,
    });
    if (result?.error || result?.status !== 0) fail(`Git bundle ${args[0] ?? 'operation'} failed`);
    return result;
  }

  async materialize({ bundle, destination, head, tree, signal = null } = {}) {
    const selectedHead = String(head ?? '').toLowerCase();
    const selectedTree = String(tree ?? '').toLowerCase();
    if (!OBJECT_FORMAT.test(selectedHead) || !OBJECT_FORMAT.test(selectedTree)) throw new TypeError('Git bundle source identity is invalid');
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) {
      throw new TypeError('Git bundle destination is invalid');
    }
    if (signal?.aborted) throw signal.reason ?? new Error('Git bundle materialization was interrupted');
    const bundleIdentity = await verifyBundleFile(bundle);
    if (!await absent(destination)) fail('Git bundle destination must not already exist');
    await mkdir(destination, { mode: 0o700 });
    try {
      this.#git(['init', '--quiet'], { cwd: destination });
      this.#git(['bundle', 'verify', bundle.location], { cwd: destination, allowFile: true });
      const heads = resultText(this.#git(['bundle', 'list-heads', bundle.location], { cwd: destination, allowFile: true }))
        .split(/\r?\n/u).filter(Boolean);
      if (heads.length !== 1 || heads[0] !== `${selectedHead} ${SOURCE_BUNDLE_REF}`) {
        fail('Git bundle advertised source does not match authority');
      }
      this.#git(['fetch', '--no-auto-maintenance', '--no-tags', bundle.location, SOURCE_BUNDLE_REF], {
        cwd: destination,
        allowFile: true,
      });
      this.#git(['checkout', '--detach', '--force', selectedHead], { cwd: destination });
      this.#git(['remote', 'add', 'origin', SOURCE_REPOSITORY], { cwd: destination });
      if (resultText(this.#git(['rev-parse', '--verify', 'HEAD'], { cwd: destination })).toLowerCase() !== selectedHead) {
        fail('Git bundle checkout head does not match authority');
      }
      if (resultText(this.#git(['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: destination })).toLowerCase() !== selectedTree) {
        fail('Git bundle checkout tree does not match authority');
      }
      if (resultText(this.#git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: destination })) !== '') {
        fail('Git bundle checkout is not clean');
      }
      for (const relative of ['package.json', 'src/cli.js']) {
        const file = path.join(destination, ...relative.split('/'));
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1) fail('Git bundle checkout does not contain the DevBridge source shape');
      }
      const after = await lstat(bundle.location, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(bundleIdentity, after)) {
        fail('Git bundle object changed during materialization');
      }
      await verifyBundleFile(bundle);
      return Object.freeze({ head: selectedHead, tree: selectedTree, root: await realpath(destination) });
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}
