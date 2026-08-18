import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { GitCommandError } from '../errors.js';
import { containedSpawnOptions, terminateProcessTree } from '../runtime/process-tree.js';

const SAFE_HOST_ENV = new Set(['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR']);
const CONTROL_PLANE_WHITESPACE = 'blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol';

function appendTail(current, chunk, maxBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  if (combined.length <= maxBytes) return combined;
  return combined.subarray(combined.length - maxBytes);
}

function copySafeHostEnvironment(source) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value != null && SAFE_HOST_ENV.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

function authConfigKey(authBaseUrl) {
  if (!authBaseUrl) return null;
  let normalized = String(authBaseUrl);
  if (!normalized.endsWith('/')) normalized += '/';
  return `http.${normalized}.extraheader`;
}

export class GitClient {
  #executable;
  #sourceEnv;
  #syntheticHome;
  #maxOutputBytes;
  #allowFileProtocol;
  #defaultTimeoutMs;

  constructor({ executable = 'git', sourceEnv = process.env, syntheticHome, maxOutputBytes = 2 * 1024 * 1024, allowFileProtocol = false, defaultTimeoutMs = 120_000 } = {}) {
    if (!syntheticHome) throw new TypeError('GitClient syntheticHome is required');
    this.#executable = executable;
    this.#sourceEnv = sourceEnv;
    this.#syntheticHome = path.resolve(syntheticHome);
    this.#maxOutputBytes = maxOutputBytes;
    this.#allowFileProtocol = allowFileProtocol;
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  async run(args, { cwd = undefined, token = null, authBaseUrl = null, timeoutMs = this.#defaultTimeoutMs, allowFailure = false } = {}) {
    await mkdir(this.#syntheticHome, { recursive: true, mode: 0o700 });
    const hooksDir = path.join(this.#syntheticHome, 'disabled-hooks');
    await mkdir(hooksDir, { recursive: true, mode: 0o700 });

    const env = copySafeHostEnvironment(this.#sourceEnv);
    env.HOME = this.#syntheticHome;
    env.USERPROFILE = this.#syntheticHome;
    env.XDG_CONFIG_HOME = this.#syntheticHome;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = 'Never';
    env.LC_ALL = 'C';
    env.LANG = 'C';

    const key = token ? authConfigKey(authBaseUrl) : null;
    if (key) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = key;
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    }

    const safeArgs = [
      '-c', `core.hooksPath=${hooksDir}`,
      '-c', 'credential.helper=',
      '-c', 'protocol.ext.allow=never',
      '-c', `protocol.file.allow=${this.#allowFileProtocol ? 'always' : 'never'}`,
      '-c', `core.whitespace=${CONTROL_PLANE_WHITESPACE}`,
      ...args
    ];
    const child = spawn(this.#executable, safeArgs, containedSpawnOptions({ cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }));

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => { stdout = appendTail(stdout, chunk, this.#maxOutputBytes); });
    child.stderr.on('data', (chunk) => { stderr = appendTail(stderr, chunk, this.#maxOutputBytes); });

    let timedOut = false;
    let termination = null;
    const timer = setTimeout(() => { timedOut = true; termination = terminateProcessTree(child); }, timeoutMs);
    timer.unref?.();

    let exit;
    try {
      exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
      });
    } finally {
      clearTimeout(timer);
      if (termination) await termination;
    }

    const result = { args: [...args], cwd: cwd ?? null, exitCode: exit.exitCode, signal: exit.signal, timedOut, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
    if (!allowFailure && (timedOut || exit.exitCode !== 0)) {
      throw new GitCommandError(timedOut ? 'git command timed out' : `git command failed with exit code ${exit.exitCode}`, result);
    }
    return result;
  }

  async version() {
    const result = await this.run(['--version'], { timeoutMs: 15_000 });
    return result.stdout.trim();
  }
}
