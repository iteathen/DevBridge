import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  createWindowsProcessContainerId,
  windowsCreateProcessCommandLine,
} from '../src/runtime/windows-processcontainer-sandbox.js';

const CAPTURE_LIMIT = 4 * 1024 * 1024;
const RUN_TIMEOUT_MS = 45_000;
const CHILD_TIMEOUT_MS = 15_000;

function tail(value, limit = 6_000) {
  const text = String(value ?? '').trim();
  return text.length <= limit ? text : text.slice(-limit);
}

function canonicalExisting(candidate) {
  if (!candidate || !existsSync(candidate)) return null;
  return realpathSync(path.resolve(candidate));
}

function dedupeExisting(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const canonical = canonicalExisting(value);
    if (!canonical) continue;
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  return result;
}

function launcherEnvironment(source = process.env) {
  const env = {};
  for (const name of [
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'SystemDrive',
    'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  ]) {
    if (source[name] != null) env[name] = String(source[name]);
  }
  return env;
}

function runtimeReadRoots(target, source = process.env) {
  const pathValue = source.Path ?? source.PATH ?? source.path ?? '';
  return dedupeExisting([
    path.dirname(target),
    ...String(pathValue).split(path.delimiter).filter(Boolean),
    source.SYSTEMROOT,
    source.SystemRoot,
    source.WINDIR,
    source.ProgramFiles,
    source['ProgramFiles(x86)'],
    source.ProgramW6432,
  ]);
}

function childEnvironment(scratch, source = process.env) {
  const systemRoot = source.SYSTEMROOT ?? source.SystemRoot ?? source.WINDIR ?? 'C:\\Windows';
  const pathValue = source.Path ?? source.PATH ?? '';
  const values = {
    SYSTEMROOT: systemRoot,
    WINDIR: source.WINDIR ?? systemRoot,
    PATH: pathValue,
    Path: pathValue,
    PATHEXT: source.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    HOME: scratch,
    USERPROFILE: scratch,
    APPDATA: scratch,
    LOCALAPPDATA: scratch,
    TEMP: scratch,
    TMP: scratch,
    TMPDIR: scratch,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
    GIT_TERMINAL_PROMPT: '0',
    DEVBRIDGE_NONINTERACTIVE: '1',
    NO_COLOR: '1',
  };
  return Object.entries(values).map(([name, value]) => `${name}=${String(value)}`);
}

function runVariant({
  sandboxExecutable,
  label,
  target,
  args,
  leastPrivilege,
  capabilities = [],
  uiDisabled = true,
}) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'devbridge-mxc-startup-')));
  try {
    const targetExecutable = canonicalExisting(target);
    if (!targetExecutable) {
      return { label, leastPrivilege, capabilities, uiDisabled, status: null, error: `target missing: ${target}` };
    }
    const config = {
      version: '0.7.0-alpha',
      containerId: createWindowsProcessContainerId(),
      containment: 'processcontainer',
      lifecycle: { destroyOnExit: true, preservePolicy: false },
      process: {
        commandLine: windowsCreateProcessCommandLine([targetExecutable, ...args]),
        cwd: scratch,
        env: childEnvironment(scratch),
        timeout: CHILD_TIMEOUT_MS,
      },
      filesystem: {
        readwritePaths: [scratch],
        readonlyPaths: runtimeReadRoots(targetExecutable),
        deniedPaths: [],
      },
      fallback: { allowDaclMutation: true },
      network: {
        defaultPolicy: 'block',
        enforcementMode: 'capabilities',
        allowLocalNetwork: false,
      },
      ui: { disable: uiDisabled, clipboard: 'none', injection: false },
      processContainer: {
        leastPrivilege,
        capabilities,
        ui: {
          isolation: 'container',
          desktopSystemControl: false,
          systemSettings: 'none',
          ime: false,
        },
      },
    };
    const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
    const outcome = spawnSync(sandboxExecutable, ['--debug', '--config-base64', encoded], {
      cwd: scratch,
      env: launcherEnvironment(),
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: CAPTURE_LIMIT,
    });
    return {
      label,
      leastPrivilege,
      capabilities,
      uiDisabled,
      status: outcome.status,
      signal: outcome.signal ?? null,
      error: outcome.error?.message ?? null,
      stdout: tail(outcome.stdout),
      stderr: tail(outcome.stderr),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  if (process.platform !== 'win32') {
    process.stdout.write(`${JSON.stringify({ skipped: true, reason: `requires Windows, got ${process.platform}` })}\n`);
    return;
  }
  const sandboxExecutable = canonicalExisting(process.env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE);
  if (!sandboxExecutable) throw new Error('DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE is required and must name the provisioned MXC executable');
  const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const nativeTarget = path.join(systemRoot, 'System32', 'where.exe');
  const nodeTarget = process.execPath;

  const results = [];
  const nativeLpac = runVariant({
    sandboxExecutable,
    label: 'native-lpac',
    target: nativeTarget,
    args: ['/?'],
    leastPrivilege: true,
  });
  results.push(nativeLpac);
  if (nativeLpac.status !== 0) {
    results.push(runVariant({
      sandboxExecutable,
      label: 'native-standard-appcontainer',
      target: nativeTarget,
      args: ['/?'],
      leastPrivilege: false,
    }));
  }

  const nodeLpac = runVariant({
    sandboxExecutable,
    label: 'node-lpac',
    target: nodeTarget,
    args: ['-e', "process.stdout.write('node-start-ok')"],
    leastPrivilege: true,
  });
  results.push(nodeLpac);
  if (nodeLpac.status !== 0) {
    results.push(runVariant({
      sandboxExecutable,
      label: 'node-lpac-registry-read',
      target: nodeTarget,
      args: ['-e', "process.stdout.write('node-start-ok')"],
      leastPrivilege: true,
      capabilities: ['registryRead'],
    }));

    const nodeStandard = runVariant({
      sandboxExecutable,
      label: 'node-standard-appcontainer',
      target: nodeTarget,
      args: ['-e', "process.stdout.write('node-start-ok')"],
      leastPrivilege: false,
    });
    results.push(nodeStandard);
    if (nodeStandard.status !== 0) {
      results.push(runVariant({
        sandboxExecutable,
        label: 'node-standard-appcontainer-ui-enabled',
        target: nodeTarget,
        args: ['-e', "process.stdout.write('node-start-ok')"],
        leastPrivilege: false,
        uiDisabled: false,
      }));
    }
  }

  process.stdout.write(`${JSON.stringify({ authoritative: false, results }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[devbridge-windows-startup-diagnostic] ${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
