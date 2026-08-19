import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';
import { captureSandboxProbeProcess } from './bubblewrap-probe.js';
import { resolveExecutable } from './executable-resolver.js';
import {
  boundedSandboxReason,
  pendingWindowsProcessContainerStatus,
  unavailableSandboxStatus,
  verifiedWindowsProcessContainerStatus,
} from './sandbox-status.js';

const MXC_SCHEMA_VERSION = '0.7.0-alpha';
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CREDENTIAL_ENVIRONMENT = new Set([
  'DEVBRIDGE_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
]);

const WINDOWS_PROBE_SCRIPT = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [projectDir, scratchDir, outsideRead, outsideWrite, stateRead, descendantMarker] = process.argv.slice(1);
function canRead(target) { try { fs.readFileSync(target); return true; } catch { return false; } }
function canWrite(target, value = 'mutated') { try { fs.writeFileSync(target, value); return true; } catch { return false; } }
function canConnect() {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: '1.1.1.1', port: 53 });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(750, () => finish(false));
  });
}
function launchDescendant() {
  const code = 'setTimeout(() => require(\'node:fs\').writeFileSync(' + JSON.stringify(descendantMarker) + ', \'escaped\'), 1200); setTimeout(() => {}, 2000);';
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  child.unref();
  return Number.isInteger(child.pid) && child.pid > 0;
}
(async () => {
  const result = {
    projectWrite: canWrite(path.join(projectDir, 'sandbox-project-write.txt'), 'project-ok'),
    scratchWrite: canWrite(path.join(scratchDir, 'sandbox-scratch-write.txt'), 'scratch-ok'),
    outsideRead: canRead(outsideRead),
    outsideWrite: canWrite(outsideWrite),
    stateRead: canRead(stateRead),
    gitWrite: canWrite(path.join(projectDir, '.git', 'config')),
    networkEgress: await canConnect(),
    descendantStarted: launchDescendant(),
  };
  process.stdout.write(JSON.stringify(result));
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exitCode = 1;
});
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function comparable(candidate) {
  const normalized = path.normalize(path.resolve(candidate));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function dedupePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = comparable(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path.resolve(value));
  }
  return result;
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function canonicalExisting(candidate, name, { directory = false } = {}) {
  const resolved = path.resolve(candidate);
  const info = await lstat(resolved);
  if (info.isSymbolicLink()) throw new PolicyError(`${name} must not be filesystem indirection`);
  if (directory && !info.isDirectory()) throw new PolicyError(`${name} must be a directory`);
  const canonical = await realpath(resolved);
  if (comparable(canonical) !== comparable(resolved)) {
    throw new PolicyError(`${name} resolves through filesystem indirection`);
  }
  return canonical;
}

function needsWindowsQuotes(value) {
  return value.length === 0 || /[ \t\n\v"]/u.test(value);
}

function quoteWindowsCreateProcessArg(value) {
  if (value.includes('\0')) throw new PolicyError('sandbox command arguments must not contain NUL');
  if (!needsWindowsQuotes(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += '\\'.repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes);
    backslashes = 0;
    result += character;
  }
  result += '\\'.repeat(backslashes * 2);
  result += '"';
  return result;
}

export function windowsCreateProcessCommandLine(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== 'string')) {
    throw new PolicyError('sandbox command must contain at least one structural string argument');
  }
  return argv.map(quoteWindowsCreateProcessArg).join(' ');
}

function safeEnvironment(source, scratchRoot) {
  const controlled = { ...source };
  for (const name of CREDENTIAL_ENVIRONMENT) delete controlled[name];
  delete controlled.HOME;
  delete controlled.USERPROFILE;
  delete controlled.APPDATA;
  delete controlled.LOCALAPPDATA;
  delete controlled.TMPDIR;
  delete controlled.TMP;
  delete controlled.TEMP;
  controlled.HOME = scratchRoot;
  controlled.USERPROFILE = scratchRoot;
  controlled.APPDATA = scratchRoot;
  controlled.LOCALAPPDATA = scratchRoot;
  controlled.TMPDIR = scratchRoot;
  controlled.TMP = scratchRoot;
  controlled.TEMP = scratchRoot;
  controlled.GIT_CONFIG_NOSYSTEM = '1';
  controlled.GIT_CONFIG_GLOBAL = 'NUL';
  controlled.GIT_TERMINAL_PROMPT = '0';
  controlled.GCM_INTERACTIVE = 'Never';
  controlled.DEVBRIDGE_NONINTERACTIVE = '1';
  controlled.NO_COLOR ??= '1';

  return Object.entries(controlled)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => {
      if (!ENVIRONMENT_NAME.test(name)) throw new PolicyError(`sandbox environment name is invalid: ${name}`);
      const text = String(value);
      if (text.includes('\0')) throw new PolicyError(`sandbox environment value contains NUL: ${name}`);
      return `${name}=${text}`;
    });
}

function localToolRoots(env) {
  const roots = [];
  const pathValue = env.Path ?? env.PATH ?? env.path ?? '';
  for (const entry of String(pathValue).split(path.delimiter).filter(Boolean)) roots.push(entry);
  for (const name of ['SYSTEMROOT', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    if (env[name]) roots.push(env[name]);
  }
  return roots;
}

function overlapsProtectedRoot(candidate, protectedRoots) {
  return protectedRoots.some((protectedRoot) =>
    isWithin(candidate, protectedRoot) || isWithin(protectedRoot, candidate));
}

async function canonicalReadRoots(values, protectedRoots) {
  const roots = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '' || !(await exists(value))) continue;
    const canonical = await canonicalExisting(value, 'sandbox read root');
    if (overlapsProtectedRoot(canonical, protectedRoots)) {
      throw new PolicyError(`sandbox read root overlaps DevBridge control state: ${canonical}`);
    }
    roots.push(canonical);
  }
  return dedupePaths(roots);
}

function managedExecutableCandidates(stateDirectory, env) {
  const candidates = [];
  if (env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE) candidates.push(env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE);
  const inferredHome = path.dirname(path.resolve(stateDirectory));
  candidates.push(path.join(inferredHome, 'sandbox', 'mxc', '0.7.0', 'wxc-exec.exe'));
  return candidates;
}

async function resolveWindowsSandboxExecutable(stateDirectory, env) {
  for (const candidate of managedExecutableCandidates(stateDirectory, env)) {
    if (!(await exists(candidate))) continue;
    return canonicalExisting(candidate, 'Windows sandbox executable');
  }
  try {
    return await resolveExecutable('wxc-exec.exe', env);
  } catch {
    return null;
  }
}

export class WindowsProcessContainerSandboxProvider {
  #requestedProvider;
  #externalReadRoots;
  #workspaceRoot;
  #stateDirectory;
  #env;
  #resolvedExecutable = null;
  #status;
  #verifyPromise = null;

  constructor({ requestedProvider = 'auto', externalReadRoots = [], workspaceRoot, stateDirectory, env = process.env } = {}) {
    this.#requestedProvider = requestedProvider;
    this.#externalReadRoots = [...externalReadRoots];
    this.#workspaceRoot = path.resolve(workspaceRoot);
    this.#stateDirectory = path.resolve(stateDirectory);
    this.#env = env;
    this.#status = pendingWindowsProcessContainerStatus({ requestedProvider });
  }

  inspect() {
    return structuredClone(this.#status);
  }

  workerIpcTargetMode() {
    return 'host-exact-files';
  }

  verify() {
    this.#verifyPromise ??= this.#verifyOnce();
    return this.#verifyPromise;
  }

  async #createScratchRoot(prefix = 'devbridge-windows-sandbox-') {
    const scratch = await mkdtemp(path.join(os.tmpdir(), prefix));
    return canonicalExisting(scratch, 'sandbox scratch root', { directory: true });
  }

  async #buildLaunch({ executable, args, cwd, env, sandbox, scratchRoot }) {
    const project = await canonicalExisting(sandbox.projectDir, 'sandbox project root', { directory: true });
    const workspace = await canonicalExisting(this.#workspaceRoot, 'sandbox workspace root', { directory: true });
    if (!isWithin(workspace, project)) throw new PolicyError('sandbox project root must stay inside the managed workspace root');

    const cwdResolved = await canonicalExisting(cwd, 'sandbox working directory', { directory: true });
    if (!isWithin(project, cwdResolved) && !isWithin(scratchRoot, cwdResolved)) {
      throw new PolicyError('sandbox working directory must stay inside the project or owned scratch root');
    }

    const targetExecutable = await canonicalExisting(executable, 'sandbox target executable');
    const protectedRoots = [this.#stateDirectory];
    const devbridgeHome = this.#env.DEVBRIDGE_HOME
      ? path.resolve(this.#env.DEVBRIDGE_HOME)
      : path.join(os.homedir(), '.devbridge');
    if (await exists(devbridgeHome)) protectedRoots.push(await canonicalExisting(devbridgeHome, 'DevBridge home', { directory: true }));

    const requestedReadRoots = [path.dirname(targetExecutable), ...localToolRoots(env)];
    if (sandbox.exposeConfiguredReadRoots !== false) requestedReadRoots.push(...this.#externalReadRoots);
    requestedReadRoots.push(...(sandbox.trustedReadRoots ?? []));
    const readRoots = await canonicalReadRoots(requestedReadRoots, protectedRoots);

    const readwritePaths = [project, scratchRoot];
    const readonlyPaths = [...readRoots];
    const deniedPaths = [];
    const gitAdmin = path.join(project, '.git');
    if (await exists(gitAdmin)) deniedPaths.push(await canonicalExisting(gitAdmin, 'sandbox Git administrative path'));

    if (sandbox.ipc) {
      const { contextSource, resultSource, contextTarget, resultTarget } = sandbox.ipc;
      if (comparable(contextSource) !== comparable(contextTarget) || comparable(resultSource) !== comparable(resultTarget)) {
        throw new PolicyError('Windows process-container IPC requires exact host-file projections');
      }
      readonlyPaths.push(await canonicalExisting(contextSource, 'worker context file'));
      readwritePaths.push(await canonicalExisting(resultSource, 'worker result file'));
    }

    const network = sandbox.network === 'unrestricted' ? 'unrestricted' : 'deny';
    const config = {
      version: MXC_SCHEMA_VERSION,
      containment: 'processcontainer',
      lifecycle: { destroyOnExit: true, preservePolicy: false },
      process: {
        commandLine: windowsCreateProcessCommandLine([targetExecutable, ...args]),
        cwd: cwdResolved,
        env: safeEnvironment(env, scratchRoot),
        timeout: 0,
      },
      filesystem: {
        readwritePaths: dedupePaths(readwritePaths),
        readonlyPaths: dedupePaths(readonlyPaths),
        deniedPaths: dedupePaths(deniedPaths),
      },
      fallback: { allowDaclMutation: true },
      network: {
        defaultPolicy: network === 'unrestricted' ? 'allow' : 'block',
        enforcementMode: 'capabilities',
        allowLocalNetwork: false,
      },
      ui: { disable: true, clipboard: 'none', injection: false },
      processContainer: {
        leastPrivilege: true,
        capabilities: [],
        ui: {
          isolation: 'container',
          desktopSystemControl: false,
          systemSettings: 'none',
          ime: false,
        },
      },
    };

    return {
      executable: this.#resolvedExecutable,
      args: ['--config-base64', Buffer.from(JSON.stringify(config), 'utf8').toString('base64')],
      cwd: project,
      env: {},
      config,
      network,
    };
  }

  async #verifyOnce() {
    if (process.platform !== 'win32') {
      this.#status = unavailableSandboxStatus({
        requestedProvider: this.#requestedProvider,
        provider: 'windows-processcontainer',
        reason: `Windows process-container sandbox is supported only on Windows, not ${process.platform}`,
      });
      return this.inspect();
    }

    this.#resolvedExecutable = await resolveWindowsSandboxExecutable(this.#stateDirectory, this.#env);
    if (!this.#resolvedExecutable) {
      this.#status = unavailableSandboxStatus({
        requestedProvider: this.#requestedProvider,
        provider: 'windows-processcontainer',
        reason: 'Microsoft MXC wxc-exec.exe is not provisioned; run DevBridge through devbridge.mjs so bootstrap can install the pinned Windows sandbox runtime',
      });
      return this.inspect();
    }

    const nativeProbe = await captureSandboxProbeProcess(this.#resolvedExecutable, ['--probe'], {
      cwd: path.dirname(this.#resolvedExecutable),
      env: {},
      timeoutMs: 5_000,
    }).catch((error) => ({ code: null, timedOut: false, truncated: false, stdout: '', stderr: error?.message ?? String(error) }));
    if (nativeProbe.code !== 0 || nativeProbe.timedOut || nativeProbe.truncated) {
      const detail = nativeProbe.stderr.trim() || nativeProbe.stdout.trim() || `exit=${nativeProbe.code ?? 'spawn-error'}`;
      this.#status = {
        ...unavailableSandboxStatus({
          requestedProvider: this.#requestedProvider,
          provider: 'windows-processcontainer',
          reason: `Windows process-container prerequisite probe failed: ${boundedSandboxReason(detail)}`,
          probeAttempted: true,
        }),
        available: true,
        verification: 'prerequisite-probe-failed',
      };
      return this.inspect();
    }

    let probeRoot = null;
    let stateProbe = null;
    try {
      await mkdir(this.#stateDirectory, { recursive: true });
      probeRoot = await mkdtemp(path.join(os.tmpdir(), 'devbridge-windows-boundary-'));
      const projectDir = path.join(probeRoot, 'project');
      const scratchDir = path.join(probeRoot, 'scratch');
      const outsideDir = path.join(probeRoot, 'outside');
      await mkdir(path.join(projectDir, '.git'), { recursive: true });
      await mkdir(scratchDir, { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      const gitConfig = path.join(projectDir, '.git', 'config');
      const outsideRead = path.join(outsideDir, 'read-sentinel.txt');
      const outsideWrite = path.join(outsideDir, 'write-sentinel.txt');
      const descendantMarker = path.join(projectDir, 'descendant-escaped.txt');
      stateProbe = path.join(this.#stateDirectory, `.sandbox-probe-${randomUUID()}`);
      await writeFile(gitConfig, 'git-control-sentinel\n');
      await writeFile(outsideRead, 'outside-sentinel\n');
      await writeFile(stateProbe, 'state-control-sentinel\n', { flag: 'wx' });

      const scratchCanonical = await canonicalExisting(scratchDir, 'sandbox probe scratch', { directory: true });
      const launch = await this.#buildLaunch({
        executable: process.execPath,
        args: ['-e', WINDOWS_PROBE_SCRIPT, projectDir, scratchDir, outsideRead, outsideWrite, stateProbe, descendantMarker],
        cwd: projectDir,
        env: { PATH: this.#env.Path ?? this.#env.PATH ?? '', Path: this.#env.Path ?? this.#env.PATH ?? '', PATHEXT: this.#env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD', SYSTEMROOT: this.#env.SYSTEMROOT ?? this.#env.SystemRoot ?? 'C:\\Windows', CI: '1' },
        sandbox: { projectDir, scratchRoot: scratchCanonical, network: 'deny' },
        scratchRoot: scratchCanonical,
      });
      const outcome = await captureSandboxProbeProcess(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, timeoutMs: 10_000 });
      let observation = null;
      try { observation = JSON.parse(outcome.stdout.trim()); } catch { observation = null; }
      await sleep(1_600);
      const descendantContained = !(await exists(descendantMarker));
      const passed = outcome.code === 0 && !outcome.timedOut && !outcome.truncated && observation &&
        observation.projectWrite === true && observation.scratchWrite === true &&
        observation.outsideRead === false && observation.outsideWrite === false &&
        observation.stateRead === false && observation.gitWrite === false && observation.networkEgress === false &&
        observation.descendantStarted === true && descendantContained &&
        await exists(path.join(projectDir, 'sandbox-project-write.txt')) &&
        await exists(path.join(scratchDir, 'sandbox-scratch-write.txt')) && !(await exists(outsideWrite)) &&
        await readFile(gitConfig, 'utf8') === 'git-control-sentinel\n' &&
        await readFile(stateProbe, 'utf8') === 'state-control-sentinel\n';

      if (!passed) {
        const detail = outcome.stderr.trim() ||
          (observation ? JSON.stringify({ ...observation, descendantContained }) : outcome.stdout.trim()) ||
          `exit=${outcome.code} signal=${outcome.signal ?? 'none'} timeout=${outcome.timedOut}`;
        this.#status = {
          ...unavailableSandboxStatus({
            requestedProvider: this.#requestedProvider,
            provider: 'windows-processcontainer',
            reason: `Windows process container failed the required filesystem/network/control-state/process-tree boundary probe: ${boundedSandboxReason(detail)}`,
            probeAttempted: true,
          }),
          available: true,
          verification: 'boundary-probe-failed',
        };
        return this.inspect();
      }

      this.#status = verifiedWindowsProcessContainerStatus({
        requestedProvider: this.#requestedProvider,
        observations: {
          projectWriteAllowed: true,
          runScratchWriteAllowed: true,
          arbitraryOutsideReadDenied: true,
          arbitraryOutsideWriteDenied: true,
          controlStateReadDenied: true,
          gitAdministrativeWriteDenied: true,
          networkEgressDenied: true,
          descendantProcessContained: true,
        },
      });
      return this.inspect();
    } catch (error) {
      this.#status = {
        ...unavailableSandboxStatus({
          requestedProvider: this.#requestedProvider,
          provider: 'windows-processcontainer',
          reason: `Windows process-container boundary verification failed: ${boundedSandboxReason(error?.message)}`,
          probeAttempted: true,
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
      throw new PolicyError(`sandboxed execution requires a verified sandbox provider; ${status.reason ?? 'provider is not verified'}`);
    }

    const scratchRoot = sandbox.scratchRoot
      ? await canonicalExisting(sandbox.scratchRoot, 'sandbox scratch root', { directory: true })
      : await this.#createScratchRoot();
    const ownedScratch = sandbox.scratchRoot == null;
    try {
      const launch = await this.#buildLaunch({ executable, args, cwd, env, sandbox, scratchRoot });
      return {
        executable: launch.executable,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        cleanup: ownedScratch ? async () => rm(scratchRoot, { recursive: true, force: true }) : null,
        evidence: {
          provider: status.provider,
          engine: 'microsoft-mxc-processcontainer',
          verified: true,
          verification: status.verification,
          filesystem: status.filesystem,
          network: sandbox.network === 'unrestricted' ? 'unrestricted' : status.network,
          gitAdministrativeState: status.gitAdministrativeState,
          processTree: status.processTree,
          workerIpc: sandbox.ipc ? 'control-owned-exact-host-files' : 'none',
        },
      };
    } catch (error) {
      if (ownedScratch) await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}
