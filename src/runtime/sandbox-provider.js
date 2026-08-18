import { spawn } from 'node:child_process';
import { access, lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';
import { resolveExecutable } from './executable-resolver.js';

const MAX_PROBE_OUTPUT = 128 * 1024;
const PROVIDERS = new Set(['auto', 'none', 'bubblewrap']);

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function boundedEnvironment(environment = {}) {
  const result = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_()]*$/u.test(name) || typeof value !== 'string') continue;
    result[name] = value;
  }
  result.GIT_TERMINAL_PROMPT = '0';
  result.PATCH_POLLER_NONINTERACTIVE = '1';
  result.NO_COLOR ??= '1';
  return result;
}

function normalizeRoots(values = []) {
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    if (!result.includes(resolved)) result.push(resolved);
  }
  return result;
}

async function rawRun(executable, args, { cwd = undefined, env = {}, timeoutMs = 10_000 } = {}) {
  const child = spawn(executable, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let overflow = false;
  const append = (current, chunk) => {
    const combined = Buffer.concat([current, Buffer.from(chunk)]);
    if (combined.length <= MAX_PROBE_OUTPUT) return combined;
    overflow = true;
    return combined.subarray(combined.length - MAX_PROBE_OUTPUT);
  };
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  timer.unref?.();
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  return {
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut,
    outputTruncated: overflow,
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
  };
}

export class NoSandboxProvider {
  constructor({ reason = 'no supported sandbox provider is configured for this host' } = {}) {
    this.reason = reason;
  }

  async verify() { return this.inspect(); }

  inspect() {
    return {
      provider: 'none',
      configured: false,
      verified: false,
      verification: 'unavailable',
      reason: this.reason,
      filesystem: 'unverified',
      network: 'unverified',
      identityBoundary: 'unverified',
    };
  }

  async prepareSpawn() {
    throw new PolicyError(`repository-code execution requires a verified sandbox provider: ${this.reason}`);
  }
}

export class BubblewrapSandboxProvider {
  #configuredExecutable;
  #externalReadRoots;
  #env;
  #status;
  #resolvedExecutable;

  constructor({ executable = 'bwrap', externalReadRoots = [], env = process.env } = {}) {
    this.#configuredExecutable = executable;
    this.#externalReadRoots = normalizeRoots(externalReadRoots);
    this.#env = env;
    this.#resolvedExecutable = null;
    this.#status = {
      provider: 'bubblewrap',
      configured: true,
      verified: false,
      verification: 'not-run',
      reason: null,
      filesystem: 'unverified',
      network: 'unverified',
      identityBoundary: 'mount-user-network-namespace',
    };
  }

  inspect() { return structuredClone(this.#status); }

  async #resolve() {
    this.#resolvedExecutable ??= await resolveExecutable(this.#configuredExecutable, this.#env);
    return this.#resolvedExecutable;
  }

  async #mountArgs({ executable, projectRoot, projectWritable, writableRoots, readOnlyRoots, exchangeDir, resultFile, network, environment, cwd }) {
    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--clearenv',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
    ];
    if (network !== 'deny') args.push('--share-net');

    const readRoots = new Set();
    for (const root of ['/usr', '/bin', '/lib', '/lib64']) if (await exists(root)) readRoots.add(path.resolve(root));
    for (const root of this.#externalReadRoots) if (await exists(root)) readRoots.add(root);
    for (const root of normalizeRoots(readOnlyRoots)) if (await exists(root)) readRoots.add(root);
    const executableDir = path.dirname(path.resolve(executable));
    if (![...readRoots].some((root) => isWithin(root, executableDir))) readRoots.add(executableDir);

    for (const root of [...readRoots].sort((a, b) => a.length - b.length)) args.push('--ro-bind', root, root);

    const project = path.resolve(projectRoot);
    args.push(projectWritable ? '--bind' : '--ro-bind', project, project);

    const gitAdminPointer = path.join(project, '.git');
    if (await exists(gitAdminPointer)) args.push('--ro-bind', '/dev/null', gitAdminPointer);

    for (const root of normalizeRoots(writableRoots)) {
      if (isWithin(project, root) && !projectWritable) throw new PolicyError('sandbox writable root may not pierce a read-only project mount');
      if (await exists(root)) args.push('--bind', root, root);
    }

    if (exchangeDir) {
      const exchange = path.resolve(exchangeDir);
      args.push('--ro-bind', exchange, exchange);
      if (resultFile) {
        const result = path.resolve(resultFile);
        if (!isWithin(exchange, result)) throw new PolicyError('sandbox result file escaped the exchange directory');
        args.push('--bind', result, result);
      }
    }

    const env = boundedEnvironment(environment);
    for (const [name, value] of Object.entries(env)) args.push('--setenv', name, value);
    args.push('--chdir', path.resolve(cwd ?? project));
    return args;
  }

  async prepareSpawn({ executable, args = [], cwd, environment = {}, sandbox = {} }) {
    if (!this.#status.verified) throw new PolicyError('bubblewrap sandbox has not passed verification');
    const bwrap = await this.#resolve();
    const wrapped = await this.#mountArgs({
      executable,
      projectRoot: sandbox.projectRoot ?? cwd,
      projectWritable: sandbox.projectWritable === true,
      writableRoots: sandbox.writableRoots ?? [],
      readOnlyRoots: sandbox.readOnlyRoots ?? [],
      exchangeDir: sandbox.exchangeDir ?? null,
      resultFile: sandbox.resultFile ?? null,
      network: sandbox.network ?? 'deny',
      environment,
      cwd,
    });
    wrapped.push('--', path.resolve(executable), ...args);
    return {
      executable: bwrap,
      args: wrapped,
      cwd: undefined,
      environment: {},
      provider: 'bubblewrap',
    };
  }

  async verify() {
    if (process.platform !== 'linux') {
      this.#status = { ...this.#status, verified: false, verification: 'unsupported-platform', reason: 'bubblewrap provider is supported only on Linux' };
      return this.inspect();
    }

    let root = null;
    try {
      const bwrap = await this.#resolve();
      const version = await rawRun(bwrap, ['--version'], { env: {}, timeoutMs: 5_000 });
      if (version.exitCode !== 0 || version.timedOut) throw new Error(`bubblewrap version probe failed: ${version.stderr || version.stdout}`);

      root = await mkdtemp(path.join(os.tmpdir(), 'patch-poller-sandbox-probe-'));
      const projectRoot = path.join(root, 'project');
      const scratchRoot = path.join(root, 'scratch');
      const controlRoot = path.join(root, 'control');
      await Promise.all([
        mkdir(projectRoot, { mode: 0o700 }),
        mkdir(scratchRoot, { mode: 0o700 }),
        mkdir(controlRoot, { mode: 0o700 }),
      ]);
      const sentinel = path.join(controlRoot, 'secret.txt');
      const outsideWrite = path.join(controlRoot, 'write.txt');
      const projectWrite = path.join(projectRoot, 'write.txt');
      const scratchWrite = path.join(scratchRoot, 'write.txt');
      await writeFile(sentinel, 'PATCH_POLLER_SANDBOX_SECRET\n', { mode: 0o600 });
      const probe = path.join(projectRoot, 'probe.mjs');
      await writeFile(probe, `import { readFile, writeFile } from 'node:fs/promises';\nimport net from 'node:net';\nconst attempt = async (fn) => { try { await fn(); return true; } catch { return false; } };\nconst network = await new Promise((resolve) => { const socket = net.connect({ host: '1.1.1.1', port: 80 }); const finish = (value) => { socket.destroy(); resolve(value); }; socket.setTimeout(500, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); });\nconst result = { externalRead: await attempt(() => readFile(${JSON.stringify(sentinel)})), externalWrite: await attempt(() => writeFile(${JSON.stringify(outsideWrite)}, 'x')), projectWrite: await attempt(() => writeFile(${JSON.stringify(projectWrite)}, 'x')), scratchWrite: await attempt(() => writeFile(${JSON.stringify(scratchWrite)}, 'x')), network };\nconsole.log(JSON.stringify(result));\nif (result.externalRead || result.externalWrite || result.projectWrite || !result.scratchWrite || result.network) process.exitCode = 23;\n`, { mode: 0o600 });

      const mountArgs = await this.#mountArgs({
        executable: process.execPath,
        projectRoot,
        projectWritable: false,
        writableRoots: [scratchRoot],
        readOnlyRoots: [],
        exchangeDir: null,
        resultFile: null,
        network: 'deny',
        environment: { PATH: this.#env.PATH ?? '' },
        cwd: projectRoot,
      });
      const outcome = await rawRun(bwrap, [...mountArgs, '--', process.execPath, probe], { env: {}, timeoutMs: 10_000 });
      if (outcome.exitCode !== 0 || outcome.timedOut || outcome.outputTruncated) {
        throw new Error(`bubblewrap containment probe failed: ${(outcome.stderr || outcome.stdout).slice(-4000)}`);
      }
      const observed = JSON.parse(outcome.stdout.trim());
      if (observed.externalRead || observed.externalWrite || observed.projectWrite || !observed.scratchWrite || observed.network) {
        throw new Error('bubblewrap containment probe observed a forbidden capability');
      }
      const scratchInfo = await stat(scratchWrite);
      if (!scratchInfo.isFile() || await readFile(scratchWrite, 'utf8') !== 'x') throw new Error('bubblewrap writable scratch proof failed');

      this.#status = {
        provider: 'bubblewrap',
        configured: true,
        verified: true,
        verification: 'boundary-probe-passed',
        reason: null,
        filesystem: 'verified-deny-external-read-write',
        network: 'verified-deny',
        identityBoundary: 'verified-mount-user-network-namespace',
      };
    } catch (error) {
      this.#status = {
        provider: 'bubblewrap',
        configured: true,
        verified: false,
        verification: 'failed',
        reason: error?.message ?? String(error),
        filesystem: 'unverified',
        network: 'unverified',
        identityBoundary: 'unverified',
      };
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
    return this.inspect();
  }
}

export function createSandboxProvider(raw = {}, { env = process.env, externalReadRoots = [] } = {}) {
  const provider = raw?.provider ?? 'auto';
  if (!PROVIDERS.has(provider)) throw new PolicyError(`unsupported sandbox provider ${provider}`);
  if (provider === 'none') return new NoSandboxProvider({ reason: 'sandbox provider is explicitly disabled by local configuration' });
  if (provider === 'bubblewrap' || (provider === 'auto' && process.platform === 'linux')) {
    return new BubblewrapSandboxProvider({ executable: raw?.executable ?? 'bwrap', externalReadRoots, env });
  }
  return new NoSandboxProvider({ reason: `no verified sandbox provider is implemented for ${process.platform}` });
}
