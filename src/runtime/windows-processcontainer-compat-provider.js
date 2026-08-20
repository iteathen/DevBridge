import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';
import { captureSandboxProbeProcess } from './bubblewrap-probe.js';
import { resolveExecutable } from './executable-resolver.js';
import { createGitlessProjectProjection } from './project-projection.js';
import {
  boundedSandboxReason,
  pendingWindowsProcessContainerStatus,
  unavailableSandboxStatus,
  verifiedWindowsProcessContainerStatus,
} from './sandbox-status.js';
import {
  canonicalizeWindowsReadRootPath,
  canonicalizeWindowsWorkspacePath,
  createWindowsProcessContainerId,
  windowsCreateProcessCommandLine,
} from './windows-processcontainer-sandbox.js';

const NATIVE_PREREQUISITE_PROBE_TIMEOUT_MS = 15_000;
const NATIVE_BOUNDARY_PROBE_TIMEOUT_MS = 35_000;
const NATIVE_CLEANUP_TIMEOUT_MS = 15_000;
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

const WINDOWS_NATIVE_PROBE_SCRIPT = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [projectDir, scratchDir, outsideRead, outsideWrite, stateRead, gitAdmin, descendantMarker] = process.argv.slice(1);
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
  const code = 'setTimeout(() => require(\'node:fs\').writeFileSync(' + JSON.stringify(descendantMarker) + ', \'escaped\'), 1200); setTimeout(() => {}, 2400);';
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
    gitRead: canRead(gitAdmin),
    gitWrite: canWrite(gitAdmin),
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
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function dedupePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const resolved = path.resolve(value);
    const key = comparable(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function encodeUtf8(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function encodeList(values) {
  return Buffer.from(`${values.join('\0')}\0`, 'utf8').toString('base64');
}

async function exists(candidate) {
  try { await access(candidate); return true; }
  catch { return false; }
}

async function canonicalExisting(candidate, name, { directory = false } = {}) {
  const resolved = path.resolve(candidate);
  const info = await lstat(resolved);
  if (info.isSymbolicLink()) throw new PolicyError(`${name} must not be filesystem indirection`);
  if (directory && !info.isDirectory()) throw new PolicyError(`${name} must be a directory`);
  const canonical = await realpath(resolved);
  if (comparable(canonical) !== comparable(resolved)) throw new PolicyError(`${name} resolves through filesystem indirection`);
  return canonical;
}

function probeProcessDetail(outcome, observation = null) {
  const state = `exit=${outcome.code ?? 'spawn-error'} signal=${outcome.signal ?? 'none'} timeout=${outcome.timedOut} truncated=${outcome.truncated}`;
  const diagnostics = [];
  if (outcome.stderr.trim()) diagnostics.push(outcome.stderr.trim());
  if (observation == null) {
    if (outcome.stdout.trim()) diagnostics.push(outcome.stdout.trim());
  } else {
    diagnostics.push(JSON.stringify(observation));
  }
  return diagnostics.length > 0 ? `${state}; ${diagnostics.join('; ')}` : state;
}

function managedHelperCandidates(stateDirectory, env) {
  const candidates = [];
  const override = env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE;
  if (override) {
    const resolved = path.resolve(override);
    if (path.basename(resolved).toLowerCase() === 'wxc-exec.exe') {
      candidates.push(path.join(path.dirname(resolved), 'devbridge-job-launcher.exe'));
    }
    candidates.push(resolved);
  }
  const inferredHome = path.dirname(path.resolve(stateDirectory));
  candidates.push(path.join(inferredHome, 'sandbox', 'windows-appcontainer', '1', 'devbridge-windows-sandbox.exe'));
  candidates.push(path.join(inferredHome, 'sandbox', 'mxc', '0.7.0', 'devbridge-job-launcher.exe'));
  return candidates;
}

async function resolveWindowsSandboxHelper(stateDirectory, env) {
  for (const candidate of managedHelperCandidates(stateDirectory, env)) {
    if (!(await exists(candidate))) continue;
    return canonicalExisting(candidate, 'Windows native AppContainer helper');
  }
  try { return await resolveExecutable('devbridge-windows-sandbox.exe', env); }
  catch { return null; }
}

function launcherEnvironment(source = process.env) {
  const env = {};
  for (const name of [
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'SystemDrive',
    'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'DEVBRIDGE_WINDOWS_SANDBOX_TRACE',
  ]) {
    if (source[name] != null) env[name] = String(source[name]);
  }
  return env;
}

export function windowsNativeReadRootCandidates({
  targetExecutable,
  externalReadRoots = [],
  trustedReadRoots = [],
  exposeConfiguredReadRoots = true,
}) {
  const roots = [path.dirname(targetExecutable)];
  if (exposeConfiguredReadRoots) roots.push(...externalReadRoots);
  roots.push(...trustedReadRoots);
  return roots;
}

function mapProjectPath(view, value) {
  if (!view.projected || typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const resolved = path.resolve(value);
  if (!isWithin(view.sourceProjectDir, resolved)) return value;
  return path.join(view.projectDir, path.relative(view.sourceProjectDir, resolved));
}

function mapProjectEnvironment(view, source) {
  if (!view.projected) return { ...source };
  const mapped = { ...source };
  for (const name of ['PATH', 'Path', 'path']) {
    if (mapped[name] == null) continue;
    mapped[name] = String(mapped[name]).split(path.delimiter).map((entry) => mapProjectPath(view, entry)).join(path.delimiter);
  }
  for (const [name, value] of Object.entries(mapped)) {
    if (['PATH', 'Path', 'path'].includes(name) || typeof value !== 'string' || !path.isAbsolute(value)) continue;
    mapped[name] = mapProjectPath(view, value);
  }
  return mapped;
}

function safeEnvironment(source, scratchRoot) {
  const controlled = { ...source };
  for (const name of CREDENTIAL_ENVIRONMENT) delete controlled[name];
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP']) delete controlled[name];
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

async function canonicalReadRoots(values, protectedRoots, workspaceRoot, project, scratch) {
  const protectedCanonical = [];
  for (const root of protectedRoots) {
    if (root && await exists(root)) protectedCanonical.push(await realpath(root));
  }
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '' || !(await exists(value))) continue;
    const canonical = await canonicalizeWindowsReadRootPath(workspaceRoot, value);
    if (protectedCanonical.some((root) => isWithin(root, canonical) || isWithin(canonical, root))) {
      throw new PolicyError(`sandbox read root overlaps hidden control/project authority: ${canonical}`);
    }
    if (isWithin(project, canonical) || isWithin(scratch, canonical)) continue;
    result.push(canonical);
  }
  return dedupePaths(result);
}

function nativePendingStatus(requestedProvider) {
  return {
    ...pendingWindowsProcessContainerStatus({ requestedProvider }),
    filesystem: 'gitless-proposal-projection-unverified',
    processTree: 'native-appcontainer-job-unverified',
  };
}

export class WindowsNativeAppContainerSandboxProvider {
  #requestedProvider;
  #externalReadRoots;
  #workspaceRoot;
  #stateDirectory;
  #env;
  #helper = null;
  #status;
  #verifyPromise = null;

  constructor({ requestedProvider = 'auto', externalReadRoots = [], workspaceRoot, stateDirectory, env = process.env } = {}) {
    this.#requestedProvider = requestedProvider;
    this.#externalReadRoots = [...externalReadRoots];
    this.#workspaceRoot = path.resolve(workspaceRoot);
    this.#stateDirectory = path.resolve(stateDirectory);
    this.#env = env;
    this.#status = nativePendingStatus(requestedProvider);
  }

  inspect() { return structuredClone(this.#status); }
  workerIpcTargetMode() { return 'host-staging-file'; }
  verify() { this.#verifyPromise ??= this.#verifyOnce(); return this.#verifyPromise; }

  async #resolveRuntime() {
    this.#helper = await resolveWindowsSandboxHelper(this.#stateDirectory, this.#env);
    return this.#helper != null;
  }

  async #createScratchRoot(prefix = 'run-') {
    await mkdir(this.#workspaceRoot, { recursive: true });
    const scratchParent = path.join(this.#workspaceRoot, '.devbridge-sandbox-scratch');
    await mkdir(scratchParent, { recursive: true });
    const parent = await canonicalizeWindowsWorkspacePath(this.#workspaceRoot, scratchParent, {
      name: 'sandbox scratch parent', directory: true,
    });
    const scratch = await mkdtemp(path.join(parent, prefix));
    return canonicalizeWindowsWorkspacePath(this.#workspaceRoot, scratch, {
      name: 'sandbox scratch root', directory: true,
    });
  }

  async #buildLaunch({ executable, args, cwd, env, sandbox, scratchRoot, hiddenProjectRoot = null }) {
    if (!this.#helper) throw new PolicyError('Windows native AppContainer helper is unavailable');
    if (sandbox.network === 'unrestricted') {
      throw new PolicyError('native Windows AppContainer provider currently supports deny-network execution only');
    }

    const project = await canonicalizeWindowsWorkspacePath(this.#workspaceRoot, sandbox.projectDir, {
      name: 'sandbox project root', directory: true,
    });
    const scratch = await canonicalizeWindowsWorkspacePath(this.#workspaceRoot, scratchRoot, {
      name: 'sandbox scratch root', directory: true,
    });
    const cwdResolved = await canonicalizeWindowsWorkspacePath(this.#workspaceRoot, cwd, {
      name: 'sandbox working directory', directory: true,
    });
    if (!isWithin(project, cwdResolved) && !isWithin(scratch, cwdResolved)) {
      throw new PolicyError('sandbox working directory must stay inside the project proposal or owned scratch root');
    }

    const targetExecutable = await canonicalExisting(executable, 'sandbox target executable');
    // PATH is process lookup/configuration data, not filesystem authority.
    // The native boundary grants only the resolved executable location plus
    // roots explicitly authorized by local sandbox policy.
    const requestedReadRoots = windowsNativeReadRootCandidates({
      targetExecutable,
      externalReadRoots: this.#externalReadRoots,
      trustedReadRoots: sandbox.trustedReadRoots ?? [],
      exposeConfiguredReadRoots: sandbox.exposeConfiguredReadRoots !== false,
    });
    const readonlyPaths = await canonicalReadRoots(
      requestedReadRoots,
      [this.#stateDirectory, hiddenProjectRoot],
      this.#workspaceRoot,
      project,
      scratch,
    );
    const readwritePaths = [project, scratch];

    if (sandbox.ipc) {
      const { contextSource, resultSource, contextTarget, resultTarget } = sandbox.ipc;
      const exchangeRoot = path.join(this.#stateDirectory, 'worker-exchange');
      const context = await canonicalExisting(contextSource, 'worker context file');
      const controlResult = await canonicalExisting(resultSource, 'control-owned worker result file');
      const stagingResult = await canonicalExisting(resultTarget, 'worker result staging file');
      if (!isWithin(exchangeRoot, context) || !isWithin(exchangeRoot, controlResult) || !isWithin(exchangeRoot, stagingResult)) {
        throw new PolicyError('Windows worker IPC files must stay inside the control-owned worker-exchange root');
      }
      if (comparable(context) !== comparable(contextTarget)) {
        throw new PolicyError('Windows AppContainer context IPC requires an exact host-file projection');
      }
      if (comparable(controlResult) === comparable(stagingResult)) {
        throw new PolicyError('Windows AppContainer worker result must use a non-authoritative staging file');
      }
      readonlyPaths.push(context);
      readwritePaths.push(stagingResult);
    }

    const readOnly = dedupePaths(readonlyPaths);
    const readWrite = dedupePaths(readwritePaths);
    const containerId = createWindowsProcessContainerId();
    const environment = safeEnvironment(env, scratch);
    const commandLine = windowsCreateProcessCommandLine([targetExecutable, ...args]);
    const readOnlyEncoded = encodeList(readOnly);
    const readWriteEncoded = encodeList(readWrite);

    return {
      executable: this.#helper,
      args: [
        '--run-appcontainer',
        containerId,
        encodeUtf8(targetExecutable),
        encodeUtf8(commandLine),
        encodeUtf8(cwdResolved),
        encodeList(environment),
        readOnlyEncoded,
        readWriteEncoded,
      ],
      cleanupArgs: ['--cleanup-appcontainer', containerId, readOnlyEncoded, readWriteEncoded],
      cwd: project,
      env: launcherEnvironment(this.#env),
      containerId,
      network: 'deny',
    };
  }

  async #cleanupContainer(launch) {
    if (!this.#helper) throw new PolicyError('Windows native AppContainer helper is unavailable');
    const outcome = await captureSandboxProbeProcess(this.#helper, launch.cleanupArgs, {
      cwd: path.dirname(this.#helper),
      env: launcherEnvironment(this.#env),
      timeoutMs: NATIVE_CLEANUP_TIMEOUT_MS,
    }).catch((error) => ({ code: null, timedOut: false, truncated: false, stdout: '', stderr: error?.message ?? String(error), signal: null }));
    if (outcome.code !== 0 || outcome.timedOut || outcome.truncated) {
      throw new PolicyError(`Windows native AppContainer cleanup failed: ${boundedSandboxReason(probeProcessDetail(outcome))}`);
    }
  }

  async #verifyOnce() {
    if (process.platform !== 'win32') {
      this.#status = unavailableSandboxStatus({
        requestedProvider: this.#requestedProvider,
        provider: 'windows-processcontainer',
        reason: `Windows AppContainer sandbox is supported only on Windows, not ${process.platform}`,
      });
      return this.inspect();
    }
    if (!(await this.#resolveRuntime())) {
      this.#status = unavailableSandboxStatus({
        requestedProvider: this.#requestedProvider,
        provider: 'windows-processcontainer',
        reason: 'DevBridge native Windows AppContainer helper is not provisioned',
      });
      return this.inspect();
    }

    const nativeProbe = await captureSandboxProbeProcess(this.#helper, ['--probe'], {
      cwd: path.dirname(this.#helper),
      env: launcherEnvironment(this.#env),
      timeoutMs: NATIVE_PREREQUISITE_PROBE_TIMEOUT_MS,
    }).catch((error) => ({ code: null, timedOut: false, truncated: false, stdout: '', stderr: error?.message ?? String(error), signal: null }));
    if (nativeProbe.code !== 0 || nativeProbe.timedOut || nativeProbe.truncated) {
      this.#status = {
        ...unavailableSandboxStatus({
          requestedProvider: this.#requestedProvider,
          provider: 'windows-processcontainer',
          reason: `Windows native AppContainer prerequisite probe failed: ${boundedSandboxReason(probeProcessDetail(nativeProbe))}`,
          probeAttempted: true,
        }),
        available: true,
        verification: 'prerequisite-probe-failed',
      };
      return this.inspect();
    }

    let probeRoot = null;
    let stateProbe = null;
    let projectView = null;
    let launch = null;
    let cleanupCompleted = false;
    try {
      await mkdir(this.#stateDirectory, { recursive: true });
      await mkdir(this.#workspaceRoot, { recursive: true });
      probeRoot = await mkdtemp(path.join(this.#workspaceRoot, '.devbridge-windows-native-boundary-'));
      const projectDir = path.join(probeRoot, 'project');
      const scratchDir = path.join(probeRoot, 'scratch');
      const outsideDir = path.join(probeRoot, 'outside');
      await mkdir(path.join(projectDir, '.git'), { recursive: true });
      await mkdir(scratchDir, { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      const gitConfig = path.join(projectDir, '.git', 'config');
      const outsideRead = path.join(outsideDir, 'read-sentinel.txt');
      const outsideWrite = path.join(outsideDir, 'write-sentinel.txt');
      stateProbe = path.join(this.#stateDirectory, `.sandbox-probe-${createWindowsProcessContainerId()}`);
      await writeFile(gitConfig, 'git-control-sentinel\n');
      await writeFile(outsideRead, 'outside-sentinel\n');
      await writeFile(stateProbe, 'state-control-sentinel\n', { flag: 'wx' });

      projectView = await createGitlessProjectProjection({ workspaceRoot: this.#workspaceRoot, projectDir });
      if (!projectView.projected) throw new PolicyError('Windows verification project did not produce a Gitless proposal projection');
      const scratchCanonical = await canonicalizeWindowsWorkspacePath(this.#workspaceRoot, scratchDir, {
        name: 'sandbox probe scratch', directory: true,
      });
      const descendantMarker = path.join(projectView.projectDir, 'descendant-escaped.txt');
      launch = await this.#buildLaunch({
        executable: process.execPath,
        args: [
          '-e', WINDOWS_NATIVE_PROBE_SCRIPT,
          projectView.projectDir,
          scratchCanonical,
          outsideRead,
          outsideWrite,
          stateProbe,
          gitConfig,
          descendantMarker,
        ],
        cwd: projectView.projectDir,
        env: {
          PATH: this.#env.Path ?? this.#env.PATH ?? '',
          Path: this.#env.Path ?? this.#env.PATH ?? '',
          PATHEXT: this.#env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
          SYSTEMROOT: this.#env.SYSTEMROOT ?? this.#env.SystemRoot ?? 'C:\\Windows',
          SystemRoot: this.#env.SystemRoot ?? this.#env.SYSTEMROOT ?? 'C:\\Windows',
          WINDIR: this.#env.WINDIR ?? this.#env.SystemRoot ?? this.#env.SYSTEMROOT ?? 'C:\\Windows',
          CI: '1',
        },
        sandbox: { projectDir: projectView.projectDir, network: 'deny' },
        scratchRoot: scratchCanonical,
        hiddenProjectRoot: projectView.sourceProjectDir,
      });
      const outcome = await captureSandboxProbeProcess(launch.executable, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        timeoutMs: NATIVE_BOUNDARY_PROBE_TIMEOUT_MS,
      });
      let observation = null;
      try { observation = JSON.parse(outcome.stdout.trim()); } catch { observation = null; }

      const boundaryDetail = probeProcessDetail(outcome, observation);
      try {
        await this.#cleanupContainer(launch);
        cleanupCompleted = true;
      } catch (error) {
        throw new PolicyError(
          `Windows native AppContainer boundary outcome before cleanup failure: ${boundedSandboxReason(boundaryDetail)}; cleanup=${boundedSandboxReason(error?.message)}`,
        );
      }
      await sleep(1_600);
      const descendantContained = !(await exists(descendantMarker));
      await projectView.importChanges();

      const passed = outcome.code === 0 && !outcome.timedOut && !outcome.truncated && observation &&
        observation.projectWrite === true && observation.scratchWrite === true &&
        observation.outsideRead === false && observation.outsideWrite === false &&
        observation.stateRead === false && observation.gitRead === false && observation.gitWrite === false &&
        observation.networkEgress === false && observation.descendantStarted === true && descendantContained &&
        await exists(path.join(projectDir, 'sandbox-project-write.txt')) &&
        await exists(path.join(scratchDir, 'sandbox-scratch-write.txt')) && !(await exists(outsideWrite)) &&
        await readFile(gitConfig, 'utf8') === 'git-control-sentinel\n' &&
        await readFile(stateProbe, 'utf8') === 'state-control-sentinel\n';

      if (!passed) {
        const detail = probeProcessDetail(outcome, observation ? { ...observation, descendantContained } : null);
        this.#status = {
          ...unavailableSandboxStatus({
            requestedProvider: this.#requestedProvider,
            provider: 'windows-processcontainer',
            reason: `Windows native AppContainer boundary probe failed: ${boundedSandboxReason(detail)}`,
            probeAttempted: true,
          }),
          available: true,
          verification: 'boundary-probe-failed',
          filesystem: 'gitless-proposal-projection-unverified',
          processTree: 'native-appcontainer-job-unverified',
        };
        return this.inspect();
      }

      this.#status = {
        ...verifiedWindowsProcessContainerStatus({
          requestedProvider: this.#requestedProvider,
          observations: {
            projectWriteAllowed: true,
            runScratchWriteAllowed: true,
            arbitraryOutsideReadDenied: true,
            arbitraryOutsideWriteDenied: true,
            controlStateReadDenied: true,
            gitAdministrativeReadDenied: true,
            gitAdministrativeWriteDenied: true,
            networkEgressDenied: true,
            descendantProcessContained: true,
          },
        }),
        filesystem: 'gitless-proposal-projection-and-run-scratch-explicit-appcontainer-acls',
        gitAdministrativeState: 'unreachable-from-worker-project-view',
        processTree: 'sandbox-root-owned-job-kill-on-close-and-wait-empty',
      };
      return this.inspect();
    } catch (error) {
      this.#status = {
        ...unavailableSandboxStatus({
          requestedProvider: this.#requestedProvider,
          provider: 'windows-processcontainer',
          reason: `Windows native AppContainer verification failed: ${boundedSandboxReason(error?.message)}`,
          probeAttempted: true,
        }),
        available: true,
        verification: 'boundary-probe-failed',
        filesystem: 'gitless-proposal-projection-unverified',
        processTree: 'native-appcontainer-job-unverified',
      };
      return this.inspect();
    } finally {
      if (launch && !cleanupCompleted) await this.#cleanupContainer(launch).catch(() => {});
      if (projectView) await projectView.cleanup().catch(() => {});
      if (stateProbe) await rm(stateProbe, { force: true }).catch(() => {});
      if (probeRoot) await rm(probeRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async prepareExecution({ executable, args, cwd, env, sandbox }) {
    const status = await this.verify();
    if (!status.verified || !this.#helper) {
      throw new PolicyError(`sandboxed execution requires a verified sandbox provider; ${status.reason ?? 'provider is not verified'}`);
    }

    const scratchRoot = sandbox.scratchRoot
      ? await canonicalizeWindowsWorkspacePath(this.#workspaceRoot, sandbox.scratchRoot, {
          name: 'sandbox scratch root', directory: true,
        })
      : await this.#createScratchRoot();
    const ownedScratch = sandbox.scratchRoot == null;
    let projectView = null;
    let launch = null;
    try {
      projectView = await createGitlessProjectProjection({
        workspaceRoot: this.#workspaceRoot,
        projectDir: sandbox.projectDir,
      });
      const mappedEnv = mapProjectEnvironment(projectView, env);
      const mappedExecutable = mapProjectPath(projectView, executable);
      const mappedArgs = args.map((value) => mapProjectPath(projectView, value));
      const mappedCwd = mapProjectPath(projectView, cwd);
      launch = await this.#buildLaunch({
        executable: mappedExecutable,
        args: mappedArgs,
        cwd: mappedCwd,
        env: mappedEnv,
        sandbox: { ...sandbox, projectDir: projectView.projectDir },
        scratchRoot,
        hiddenProjectRoot: projectView.projected ? projectView.sourceProjectDir : null,
      });

      let cleanupPromise = null;
      const cleanup = () => {
        cleanupPromise ??= (async () => {
          let firstError = null;
          try { await this.#cleanupContainer(launch); }
          catch (error) { firstError = error; }
          if (!firstError) {
            try { await projectView.importChanges(); }
            catch (error) { firstError = error; }
          }
          try { await projectView.cleanup(); }
          catch (error) { firstError ??= error; }
          if (ownedScratch) {
            try { await rm(scratchRoot, { recursive: true, force: true }); }
            catch (error) { firstError ??= error; }
          }
          if (firstError) throw firstError;
        })();
        return cleanupPromise;
      };

      return {
        executable: launch.executable,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        cleanup,
        evidence: {
          provider: status.provider,
          engine: 'devbridge-native-appcontainer-job-v1',
          verified: true,
          verification: status.verification,
          filesystem: status.filesystem,
          network: status.network,
          gitAdministrativeState: status.gitAdministrativeState,
          processTree: status.processTree,
          projectView: projectView.projected ? 'gitless-proposal-projection' : 'direct-non-git-project',
          workerIpc: sandbox.ipc ? 'control-context-plus-worker-staging-import' : 'none',
        },
      };
    } catch (error) {
      if (launch) await this.#cleanupContainer(launch).catch(() => {});
      if (projectView) await projectView.cleanup().catch(() => {});
      if (ownedScratch) await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}

export const WindowsMxcCompatibilitySandboxProvider = WindowsNativeAppContainerSandboxProvider;
