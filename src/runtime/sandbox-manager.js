import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

export const EXECUTION_CLASS_STATIC = 'static-safe';
export const EXECUTION_CLASS_REPOSITORY = 'repository-code-executing';

const VERIFY_TIMEOUT_MS = 15_000;
const CAPTURE_LIMIT = 256 * 1024;
// Only conventional runtime/library roots and PATCH-POLLER's current Node
// installation are visible by default. User-local/optional tool roots must be
// explicitly allowlisted by the local tool profile.
const DEFAULT_SYSTEM_READ_ROOTS = ['/usr', '/bin', '/lib', '/lib64'];

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function realDirectory(candidate, label) {
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError(`${label} must be a real directory`);
  return path.resolve(candidate);
}

function containedBy(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function captureTail(current, chunk) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= CAPTURE_LIMIT ? next : next.subarray(next.length - CAPTURE_LIMIT);
}

async function runCaptured(executable, args, options = {}) {
  const child = spawn(executable, args, containedSpawnOptions({
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => { stdout = captureTail(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = captureTail(stderr, chunk); });
  let timedOut = false;
  let termination = null;
  const timer = setTimeout(() => {
    timedOut = true;
    termination = terminateProcessTree(child);
  }, options.timeoutMs ?? VERIFY_TIMEOUT_MS);
  timer.unref?.();
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(async () => {
    clearTimeout(timer);
    if (termination) await termination;
  });
  return {
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
  };
}

function sanitizedFailure(error) {
  const message = String(error?.message ?? error ?? 'unknown failure');
  if (/not found|not installed|PATH/iu.test(message)) return 'provider-unavailable';
  if (/platform/iu.test(message)) return 'unsupported-platform';
  return 'verification-failed';
}

function setEnvironmentArgs(args, env) {
  args.push('--clearenv');
  const normalized = { ...env, HOME: '/nonexistent', TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' };
  for (const [name, value] of Object.entries(normalized)) {
    if (value == null) continue;
    args.push('--setenv', String(name), String(value));
  }
}

export class BubblewrapSandboxProvider {
  #configuredExecutable;
  #env;
  #platform;
  #resolvedExecutable = null;
  #verification = null;

  constructor({ executable = 'bwrap', env = process.env, platform = process.platform } = {}) {
    this.#configuredExecutable = executable;
    this.#env = env;
    this.#platform = platform;
  }

  get name() { return 'bubblewrap'; }

  async #resolve() {
    if (this.#platform !== 'linux') throw new PolicyError('bubblewrap sandbox provider is supported only on Linux');
    this.#resolvedExecutable ??= await resolveExecutable(this.#configuredExecutable, this.#env);
    return this.#resolvedExecutable;
  }

  async #systemRoots() {
    const roots = [];
    for (const candidate of DEFAULT_SYSTEM_READ_ROOTS) {
      if (await exists(candidate)) roots.push(path.resolve(candidate));
    }
    const runtimeRoot = path.dirname(path.dirname(path.resolve(process.execPath)));
    if (await exists(runtimeRoot) && !roots.some((root) => containedBy(root, runtimeRoot))) {
      roots.push(await realDirectory(runtimeRoot, 'PATCH-POLLER Node runtime root'));
    }
    return [...new Set(roots)];
  }

  async buildLaunch({
    executable,
    args = [],
    cwd,
    env = {},
    projectDir,
    projectWrite = false,
    writableRoots = [],
    readOnlyRoots = [],
  }) {
    const providerExecutable = await this.#resolve();
    const project = await realDirectory(projectDir, 'sandbox project root');
    const sandboxArgs = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
    ];

    const mountedReadRoots = await this.#systemRoots();
    for (const root of mountedReadRoots) sandboxArgs.push('--ro-bind', root, root);
    for (const root of readOnlyRoots) {
      const safe = await realDirectory(root, 'sandbox read-only root');
      if (mountedReadRoots.some((mounted) => containedBy(mounted, safe))) continue;
      mountedReadRoots.push(safe);
      sandboxArgs.push('--ro-bind', safe, safe);
    }
    sandboxArgs.push(projectWrite ? '--bind' : '--ro-bind', project, project);

    const gitPath = path.join(project, '.git');
    if (await exists(gitPath)) {
      const info = await lstat(gitPath);
      if (info.isDirectory()) sandboxArgs.push('--tmpfs', gitPath);
      else sandboxArgs.push('--ro-bind', '/dev/null', gitPath);
    }

    for (const root of writableRoots) {
      const safe = await realDirectory(root, 'sandbox writable root');
      sandboxArgs.push('--bind', safe, safe);
    }

    setEnvironmentArgs(sandboxArgs, env);
    sandboxArgs.push('--chdir', path.resolve(cwd), '--', executable, ...args);
    return {
      executable: providerExecutable,
      args: sandboxArgs,
      cwd: project,
      env: {},
      sandbox: { provider: this.name, configured: true, verified: true },
    };
  }

  async verify({ refresh = false } = {}) {
    if (this.#verification && !refresh) return this.#verification;
    const checkedAt = new Date().toISOString();
    if (this.#platform !== 'linux') {
      this.#verification = {
        provider: this.name,
        configured: true,
        available: false,
        verified: false,
        reason: 'unsupported-platform',
        boundaries: null,
        checkedAt,
      };
      return this.#verification;
    }

    let root = null;
    let server = null;
    try {
      await this.#resolve();
      root = await mkdtemp(path.join(os.tmpdir(), `pp-sandbox-${randomBytes(4).toString('hex')}-`));
      const projectDir = path.join(root, 'project');
      const externalDir = path.join(root, 'control-state');
      await mkdir(path.join(projectDir, '.git'), { recursive: true, mode: 0o700 });
      await mkdir(externalDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(projectDir, 'inside.txt'), 'inside', { mode: 0o600 });
      await writeFile(path.join(projectDir, '.git', 'authority'), 'git-admin', { mode: 0o600 });
      const externalRead = path.join(externalDir, 'secret.txt');
      const externalWrite = path.join(externalDir, 'worker-write.txt');
      await writeFile(externalRead, 'control-secret', { mode: 0o600 });

      server = net.createServer(() => {});
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      const script = String.raw`
const fs = require('node:fs');
const net = require('node:net');
function denied(fn) { try { fn(); return false; } catch { return true; } }
(async () => {
  const insideRead = fs.readFileSync('inside.txt', 'utf8') === 'inside';
  const projectWriteDenied = denied(() => fs.writeFileSync('worker.txt', 'x'));
  const externalReadDenied = denied(() => fs.readFileSync(process.env.PP_EXTERNAL_READ, 'utf8'));
  const externalWriteDenied = denied(() => fs.writeFileSync(process.env.PP_EXTERNAL_WRITE, 'x'));
  const gitAdminHidden = denied(() => fs.readFileSync('.git/authority', 'utf8'));
  const networkDenied = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(process.env.PP_LOOPBACK_PORT) });
    const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 500);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once('error', () => { clearTimeout(timer); resolve(true); });
  });
  process.stdout.write(JSON.stringify({ insideRead, projectWriteDenied, externalReadDenied, externalWriteDenied, gitAdminHidden, networkDenied }) + '\n');
})().catch((error) => { console.error(error.message); process.exitCode = 2; });`;
      const launch = await this.buildLaunch({
        executable: process.execPath,
        args: ['-e', script],
        cwd: projectDir,
        env: {
          PP_EXTERNAL_READ: externalRead,
          PP_EXTERNAL_WRITE: externalWrite,
          PP_LOOPBACK_PORT: String(port),
        },
        projectDir,
        projectWrite: false,
      });
      const result = await runCaptured(launch.executable, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
      let boundaries = null;
      try { boundaries = JSON.parse(result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? 'null'); }
      catch { boundaries = null; }
      const verified = result.exitCode === 0 && result.timedOut !== true && boundaries &&
        boundaries.insideRead === true && boundaries.projectWriteDenied === true &&
        boundaries.externalReadDenied === true && boundaries.externalWriteDenied === true &&
        boundaries.gitAdminHidden === true && boundaries.networkDenied === true;
      this.#verification = {
        provider: this.name,
        configured: true,
        available: true,
        verified: verified === true,
        reason: verified ? null : 'boundary-probe-failed',
        boundaries: boundaries ? {
          projectRead: boundaries.insideRead === true,
          projectWriteDenied: boundaries.projectWriteDenied === true,
          externalReadDenied: boundaries.externalReadDenied === true,
          externalWriteDenied: boundaries.externalWriteDenied === true,
          gitAdminHidden: boundaries.gitAdminHidden === true,
          networkDenied: boundaries.networkDenied === true,
        } : null,
        checkedAt,
      };
    } catch (error) {
      this.#verification = {
        provider: this.name,
        configured: true,
        available: false,
        verified: false,
        reason: sanitizedFailure(error),
        boundaries: null,
        checkedAt,
      };
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (root) await rm(root, { recursive: true, force: true });
    }
    return this.#verification;
  }
}

export class SandboxManager {
  #provider;
  #allowUnsafe;

  constructor({ provider = null, allowUnsafeUncontained = false } = {}) {
    this.#provider = provider;
    this.#allowUnsafe = allowUnsafeUncontained === true;
  }

  async inspect({ refresh = false } = {}) {
    if (!this.#provider) {
      return {
        provider: 'none',
        configured: false,
        available: false,
        verified: false,
        reason: 'no-provider-configured',
        boundaries: null,
        checkedAt: new Date().toISOString(),
      };
    }
    return this.#provider.verify({ refresh });
  }

  async prepareLaunch(request) {
    if (request.executionClass !== EXECUTION_CLASS_REPOSITORY) {
      return {
        executable: request.executable,
        args: request.args ?? [],
        cwd: request.cwd,
        env: request.env ?? {},
        sandbox: { provider: 'none', configured: false, verified: false, staticSafe: true },
      };
    }

    const verification = await this.inspect();
    if (!verification.verified) {
      if (request.allowUnsafeUncontained === true && this.#allowUnsafe) {
        return {
          executable: request.executable,
          args: request.args ?? [],
          cwd: request.cwd,
          env: request.env ?? {},
          sandbox: { ...verification, unsafeOverride: true },
        };
      }
      throw new PolicyError(`repository-code execution requires a verified sandbox provider (${verification.reason ?? 'unverified'})`);
    }
    return this.#provider.buildLaunch(request);
  }
}

export function createSandboxManager(config = {}, options = {}) {
  const providerName = config.provider ?? 'auto';
  let provider = null;
  if (providerName === 'bubblewrap' || (providerName === 'auto' && process.platform === 'linux')) {
    provider = new BubblewrapSandboxProvider({
      executable: config.executable ?? 'bwrap',
      env: options.env ?? process.env,
      platform: options.platform ?? process.platform,
    });
  }
  if (!['auto', 'bubblewrap', 'none'].includes(providerName)) throw new PolicyError(`unsupported sandbox provider ${providerName}`);
  return new SandboxManager({
    provider,
    allowUnsafeUncontained: options.allowUnsafeUncontained === true,
  });
}
