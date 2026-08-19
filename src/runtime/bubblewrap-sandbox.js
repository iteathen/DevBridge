import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';
import { resolveExecutable } from './executable-resolver.js';
import { BUBBLEWRAP_PROBE_SCRIPT, captureSandboxProbeProcess } from './bubblewrap-probe.js';
import {
  boundedSandboxReason,
  pendingBubblewrapStatus,
  unavailableSandboxStatus,
  verifiedBubblewrapStatus,
} from './sandbox-status.js';
import {
  WORKER_CONTEXT_FILE,
  WORKER_EXCHANGE_PROTOCOL,
  WORKER_RESULT_FILE,
} from './worker-exchange.js';

const STANDARD_READ_ROOTS = ['/usr'];
const COMPATIBILITY_READ_PATHS = ['/bin', '/sbin', '/lib', '/lib64'];
const STANDARD_READ_FILES = ['/etc/ld.so.cache', '/etc/localtime'];
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlaps(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

async function exists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function effectiveCapabilitiesAreZero(value) {
  return typeof value === 'string' && /^0+$/u.test(value);
}

async function canonicalExisting(candidate, name) {
  const resolved = path.resolve(candidate);
  const info = await lstat(resolved);
  if (info.isSymbolicLink()) throw new PolicyError(`${name} must not be a symbolic link`);
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new PolicyError(`${name} must use its canonical path`);
  return { path: canonical, info };
}

export class BubblewrapSandboxProvider {
  #requestedProvider;
  #configuredExecutable;
  #externalReadRoots;
  #workspaceRoot;
  #stateDirectory;
  #env;
  #resolvedExecutable = null;
  #status;
  #verificationPromise = null;

  constructor({
    requestedProvider = 'auto',
    executable = 'bwrap',
    externalReadRoots = [],
    workspaceRoot,
    stateDirectory,
    env = process.env,
  } = {}) {
    this.#requestedProvider = requestedProvider;
    this.#configuredExecutable = executable;
    this.#externalReadRoots = [...externalReadRoots];
    this.#workspaceRoot = path.resolve(workspaceRoot);
    this.#stateDirectory = path.resolve(stateDirectory);
    this.#env = env;
    this.#status = pendingBubblewrapStatus({ requestedProvider });
  }

  inspect() {
    return { ...this.#status };
  }

  async verify({ force = false } = {}) {
    if (this.#status.verified && !force) return this.inspect();
    if (this.#verificationPromise && !force) return this.#verificationPromise;
    this.#verificationPromise = this.#verifyOnce().finally(() => { this.#verificationPromise = null; });
    return this.#verificationPromise;
  }

  #sensitiveRoots() {
    const home = path.resolve(os.homedir());
    return [
      this.#stateDirectory,
      path.join(home, '.devbridge'),
      path.join(home, '.config', 'gh'),
      path.join(home, '.ssh'),
    ].map((entry) => path.resolve(entry));
  }

  #assertReadRootAllowed(root) {
    const home = path.resolve(os.homedir());
    if (root === home || isWithin(root, home)) {
      throw new PolicyError('sandbox read roots may not expose the operator home root or its parent');
    }
    for (const sensitive of this.#sensitiveRoots()) {
      if (overlaps(root, sensitive)) {
        throw new PolicyError('sandbox read roots may not overlap DevBridge or credential control state');
      }
    }
  }

  async #canonicalReadRoots(executable, {
    includeConfiguredReadRoots = true,
    trustedReadRoots = [],
  } = {}) {
    const roots = [];
    if (includeConfiguredReadRoots) {
      for (const candidate of this.#externalReadRoots) {
        if (!(await exists(candidate))) throw new PolicyError('configured sandbox external read root does not exist');
        const canonical = await realpath(path.resolve(candidate));
        this.#assertReadRootAllowed(canonical);
        roots.push(canonical);
      }
    }

    for (const candidate of trustedReadRoots) {
      const trusted = await canonicalExisting(candidate, 'trusted worker runtime read root');
      if (!trusted.info.isDirectory() && !trusted.info.isFile()) {
        throw new PolicyError('trusted worker runtime read root must be a regular file or directory');
      }
      this.#assertReadRootAllowed(trusted.path);
      roots.push(trusted.path);
    }

    const executablePath = path.resolve(executable);
    const standardPaths = [...STANDARD_READ_ROOTS, ...COMPATIBILITY_READ_PATHS];
    const alreadyVisible = standardPaths.some((root) => isWithin(root, executablePath)) ||
      roots.some((root) => isWithin(root, executablePath));
    if (!alreadyVisible) {
      const binDir = path.dirname(executablePath);
      const toolRoot = path.dirname(binDir) === path.parse(binDir).root ? binDir : path.dirname(binDir);
      this.#assertReadRootAllowed(toolRoot);
      roots.push(toolRoot);
    }
    return [...new Set(roots)];
  }

  async #appendSystemFilesystem(bwrapArgs) {
    for (const root of STANDARD_READ_ROOTS) {
      if (await exists(root)) bwrapArgs.push('--ro-bind', root, root);
    }
    for (const candidate of COMPATIBILITY_READ_PATHS) {
      if (!(await exists(candidate))) continue;
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        bwrapArgs.push('--symlink', await readlink(candidate), candidate);
      } else {
        bwrapArgs.push('--ro-bind', candidate, candidate);
      }
    }
    for (const file of STANDARD_READ_FILES) {
      if (await exists(file)) bwrapArgs.push('--ro-bind', file, file);
    }
  }

  async #appendWorkerIpc(bwrapArgs, ipc) {
    if (ipc?.protocol !== WORKER_EXCHANGE_PROTOCOL) throw new PolicyError('worker sandbox IPC protocol is invalid');
    if (ipc.contextTarget !== WORKER_CONTEXT_FILE || ipc.resultTarget !== WORKER_RESULT_FILE) {
      throw new PolicyError('worker sandbox IPC targets are not the fixed DevBridge exchange endpoints');
    }

    const context = await canonicalExisting(ipc.contextSource, 'worker context source');
    const result = await canonicalExisting(ipc.resultSource, 'worker result source');
    if (!context.info.isFile() || !result.info.isFile()) throw new PolicyError('worker sandbox IPC sources must be regular files');
    const exchangeRoot = path.join(this.#stateDirectory, 'worker-exchange');
    if (!isWithin(exchangeRoot, context.path) || !isWithin(exchangeRoot, result.path)) {
      throw new PolicyError('worker sandbox IPC sources must remain under the dedicated control-owned worker exchange');
    }

    bwrapArgs.push('--dir', '/run/devbridge-exchange');
    bwrapArgs.push('--ro-bind', context.path, WORKER_CONTEXT_FILE);
    bwrapArgs.push('--bind', result.path, WORKER_RESULT_FILE);
    bwrapArgs.push('--remount-ro', '/run/devbridge-exchange');
  }

  async #derivedScratchRoot(projectDir, args) {
    const projectParent = path.dirname(projectDir);
    for (const value of args) {
      if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
      const resolved = path.resolve(value);
      if (isWithin(projectDir, resolved) || !isWithin(this.#workspaceRoot, resolved)) continue;
      let cursor = resolved;
      while (isWithin(projectParent, cursor) && cursor !== projectParent) {
        if (path.dirname(cursor) === projectParent && path.basename(cursor).startsWith('.devbridge-scratch-')) {
          if (!(await exists(cursor))) return null;
          const scratch = await canonicalExisting(cursor, 'sandbox derived scratch root');
          if (!scratch.info.isDirectory()) throw new PolicyError('sandbox derived scratch root must be a directory');
          return scratch.path;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    }
    return null;
  }

  async #buildLaunch({ executable, args, cwd, env, sandbox }) {
    if (!path.isAbsolute(executable)) throw new PolicyError('sandboxed executable must be an absolute locally resolved path');
    const project = await canonicalExisting(sandbox.projectDir, 'sandbox project root');
    if (!project.info.isDirectory()) throw new PolicyError('sandbox project root must be a directory');

    const network = sandbox.network ?? 'deny';
    if (!['deny', 'unrestricted'].includes(network)) {
      throw new PolicyError('verified Bubblewrap worker isolation supports network deny or unrestricted sharing; restricted network requires another verified provider');
    }

    let scratchRoot = await this.#derivedScratchRoot(project.path, args);
    if (sandbox.scratchRoot && await exists(sandbox.scratchRoot)) {
      const scratch = await canonicalExisting(sandbox.scratchRoot, 'sandbox scratch root');
      if (!scratch.info.isDirectory()) throw new PolicyError('sandbox scratch root must be a directory');
      if (isWithin(project.path, scratch.path) || isWithin(scratch.path, project.path)) {
        throw new PolicyError('sandbox scratch root must remain separate from the project root');
      }
      scratchRoot = scratch.path;
    }

    const cwdResolved = path.resolve(cwd);
    if (!isWithin(project.path, cwdResolved) && !(scratchRoot && isWithin(scratchRoot, cwdResolved))) {
      throw new PolicyError('sandbox cwd must be inside the project or current run scratch root');
    }

    const readRoots = await this.#canonicalReadRoots(executable, {
      includeConfiguredReadRoots: sandbox.exposeConfiguredReadRoots !== false,
      trustedReadRoots: sandbox.trustedReadRoots ?? [],
    });
    const bwrapArgs = [
      '--unshare-all',
      '--new-session',
      '--die-with-parent',
      '--clearenv',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--dir', '/tmp/devbridge-home',
      '--dir', '/run',
    ];
    if (network === 'unrestricted') bwrapArgs.push('--share-net');
    await this.#appendSystemFilesystem(bwrapArgs);
    for (const root of readRoots) bwrapArgs.push('--ro-bind', root, root);

    bwrapArgs.push('--bind', project.path, project.path);
    if (scratchRoot) bwrapArgs.push('--bind', scratchRoot, scratchRoot);
    const gitAdmin = path.join(project.path, '.git');
    if (await exists(gitAdmin)) {
      const info = await lstat(gitAdmin);
      if (info.isSymbolicLink()) throw new PolicyError('sandbox refuses a symbolic-link .git administrative path');
      bwrapArgs.push('--ro-bind', gitAdmin, gitAdmin);
    }
    if (sandbox.ipc) await this.#appendWorkerIpc(bwrapArgs, sandbox.ipc);

    const controlledEnvironment = { ...env };
    delete controlledEnvironment.HOME;
    delete controlledEnvironment.USERPROFILE;
    delete controlledEnvironment.TMPDIR;
    delete controlledEnvironment.TMP;
    delete controlledEnvironment.TEMP;
    controlledEnvironment.HOME = '/tmp/devbridge-home';
    controlledEnvironment.TMPDIR = '/tmp';
    controlledEnvironment.TMP = '/tmp';
    controlledEnvironment.TEMP = '/tmp';
    for (const [name, value] of Object.entries(controlledEnvironment).sort(([a], [b]) => a.localeCompare(b))) {
      if (!ENVIRONMENT_NAME.test(name)) throw new PolicyError(`sandbox environment name is invalid: ${name}`);
      const text = String(value);
      if (text.includes('\0')) throw new PolicyError(`sandbox environment value contains NUL: ${name}`);
      bwrapArgs.push('--setenv', name, text);
    }

    bwrapArgs.push('--chdir', cwdResolved, '--', executable, ...args);
    return { executable: this.#resolvedExecutable, args: bwrapArgs, cwd: '/', env: {} };
  }

  async #verifyOnce() {
    if (process.platform !== 'linux') {
      this.#status = unavailableSandboxStatus({
        requestedProvider: this.#requestedProvider,
        provider: 'bubblewrap',
        reason: `bubblewrap sandbox is supported only on Linux, not ${process.platform}`,
      });
      return this.inspect();
    }
    if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
      this.#status = unavailableSandboxStatus({
        requestedProvider: this.#requestedProvider,
        provider: 'bubblewrap',
        reason: 'repository-code sandboxing is refused while DevBridge is running as root; run it under the dedicated unprivileged service account',
      });
      return this.inspect();
    }
    try {
      this.#resolvedExecutable = await resolveExecutable(this.#configuredExecutable, this.#env);
    } catch {
      this.#status = unavailableSandboxStatus({
        requestedProvider: this.#requestedProvider,
        provider: 'bubblewrap',
        reason: 'bubblewrap executable is not available from local operator configuration/PATH',
      });
      return this.inspect();
    }

    let probeRoot = null;
    let stateProbe = null;
    try {
      await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
      probeRoot = await mkdtemp(path.join(os.tmpdir(), 'devbridge-sandbox-probe-'));
      const projectDir = path.join(probeRoot, 'project');
      const scratchDir = path.join(probeRoot, 'scratch');
      const outsideDir = path.join(probeRoot, 'outside');
      await mkdir(path.join(projectDir, '.git'), { recursive: true, mode: 0o700 });
      await mkdir(scratchDir, { recursive: true, mode: 0o700 });
      await mkdir(outsideDir, { recursive: true, mode: 0o700 });
      const gitConfig = path.join(projectDir, '.git', 'config');
      const outsideRead = path.join(outsideDir, 'read-sentinel.txt');
      const outsideWrite = path.join(outsideDir, 'write-sentinel.txt');
      stateProbe = path.join(this.#stateDirectory, `.sandbox-probe-${randomUUID()}`);
      await writeFile(gitConfig, 'git-control-sentinel\n', { mode: 0o600 });
      await writeFile(outsideRead, 'outside-sentinel\n', { mode: 0o600 });
      await writeFile(stateProbe, 'state-control-sentinel\n', { mode: 0o600, flag: 'wx' });

      const launch = await this.#buildLaunch({
        executable: process.execPath,
        args: ['-e', BUBBLEWRAP_PROBE_SCRIPT, projectDir, scratchDir, outsideRead, outsideWrite, stateProbe],
        cwd: projectDir,
        env: { PATH: this.#env.PATH ?? '', CI: '1' },
        sandbox: { projectDir, scratchRoot: scratchDir },
      });
      const outcome = await captureSandboxProbeProcess(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env });
      let observation = null;
      try { observation = JSON.parse(outcome.stdout.trim()); } catch { observation = null; }
      const passed = outcome.code === 0 && !outcome.timedOut && !outcome.truncated && observation &&
        observation.projectWrite === true && observation.scratchWrite === true &&
        observation.outsideRead === false && observation.outsideWrite === false &&
        observation.stateRead === false && observation.gitWrite === false && observation.networkEgress === false &&
        effectiveCapabilitiesAreZero(observation.effectiveCapabilities) &&
        await exists(path.join(projectDir, 'sandbox-project-write.txt')) &&
        await exists(path.join(scratchDir, 'sandbox-scratch-write.txt')) && !(await exists(outsideWrite)) &&
        await readFile(gitConfig, 'utf8') === 'git-control-sentinel\n' &&
        await readFile(stateProbe, 'utf8') === 'state-control-sentinel\n';
      if (!passed) {
        const detail = outcome.stderr.trim() ||
          (observation ? JSON.stringify(observation) : outcome.stdout.trim()) ||
          `exit=${outcome.code} signal=${outcome.signal ?? 'none'} timeout=${outcome.timedOut}`;
        this.#status = {
          ...unavailableSandboxStatus({
            requestedProvider: this.#requestedProvider,
            provider: 'bubblewrap',
            reason: `bubblewrap was found but failed the required filesystem/network/control-state boundary probe: ${boundedSandboxReason(detail)}`,
          }),
          available: true,
          verification: 'boundary-probe-failed',
        };
        return this.inspect();
      }
      this.#status = verifiedBubblewrapStatus({ requestedProvider: this.#requestedProvider });
      return this.inspect();
    } catch (error) {
      this.#status = {
        ...unavailableSandboxStatus({
          requestedProvider: this.#requestedProvider,
          provider: 'bubblewrap',
          reason: `bubblewrap boundary verification failed: ${boundedSandboxReason(error?.message)}`,
        }),
        available: true,
        verification: 'boundary-probe-failed',
      };
      return this.inspect();
    } finally {
      if (stateProbe) await rm(stateProbe, { force: true }).catch(() => {});
      if (probeRoot) await rm(probeRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async prepareExecution({ executable, args, cwd, env, sandbox }) {
    const status = await this.verify();
    if (!status.verified || !this.#resolvedExecutable) {
      throw new PolicyError(
        `sandboxed execution requires a verified sandbox provider; ${status.reason ?? 'provider is not verified'}`,
      );
    }
    const launch = await this.#buildLaunch({ executable, args, cwd, env, sandbox });
    return {
      ...launch,
      evidence: {
        provider: status.provider,
        verified: true,
        verification: status.verification,
        filesystem: status.filesystem,
        network: sandbox.network === 'unrestricted' ? 'unrestricted' : status.network,
        gitAdministrativeState: status.gitAdministrativeState,
        workerIpc: sandbox.ipc ? 'control-owned-exact-file-bindings' : 'none',
      },
    };
  }
}
