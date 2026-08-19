import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  createWindowsProcessContainerId,
  windowsCreateProcessCommandLine,
} from '../src/runtime/windows-processcontainer-sandbox.js';

const TIMEOUT_MS = 45_000;

function canonical(candidate) {
  if (!candidate || !existsSync(candidate)) return null;
  return realpathSync(path.resolve(candidate));
}

function launcherEnvironment(source = process.env) {
  const env = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
    if (source[name] != null) env[name] = String(source[name]);
  }
  return env;
}

function childEnvironment(scratch) {
  const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const pathValue = process.env.Path ?? process.env.PATH ?? '';
  return [
    `SYSTEMROOT=${systemRoot}`,
    `WINDIR=${process.env.WINDIR ?? systemRoot}`,
    `PATH=${pathValue}`,
    `Path=${pathValue}`,
    `PATHEXT=${process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'}`,
    `HOME=${scratch}`,
    `USERPROFILE=${scratch}`,
    `APPDATA=${scratch}`,
    `LOCALAPPDATA=${scratch}`,
    `TEMP=${scratch}`,
    `TMP=${scratch}`,
  ];
}

function readRoots(target) {
  const systemRoot = canonical(process.env.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows');
  const targetRoot = canonical(path.dirname(target));
  return [...new Set([systemRoot, targetRoot].filter(Boolean).map((value) => value.toLowerCase()))];
}

function runVariant(sandboxExecutable, { label, leastPrivilege = true, capabilities = [] }) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'devbridge-winsock-')));
  try {
    const target = canonical(process.execPath);
    const config = {
      version: '0.7.0-alpha',
      containerId: createWindowsProcessContainerId(),
      containment: 'processcontainer',
      lifecycle: { destroyOnExit: true, preservePolicy: false },
      process: {
        commandLine: windowsCreateProcessCommandLine([
          target,
          '-e',
          "require('node:net'); process.stdout.write('winsock-ok')",
        ]),
        cwd: scratch,
        env: childEnvironment(scratch),
        timeout: 15_000,
      },
      filesystem: {
        readwritePaths: [scratch],
        readonlyPaths: readRoots(target),
        deniedPaths: [],
      },
      fallback: { allowDaclMutation: true },
      network: {
        defaultPolicy: 'block',
        enforcementMode: 'both',
        allowLocalNetwork: false,
      },
      ui: { disable: false, clipboard: 'none', injection: false },
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
    const outcome = spawnSync(sandboxExecutable, ['--config-base64', encoded], {
      cwd: scratch,
      env: launcherEnvironment(),
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return {
      label,
      leastPrivilege,
      capabilities,
      status: outcome.status,
      error: outcome.error?.message ?? null,
      stdout: String(outcome.stdout ?? '').trim().slice(-1000),
      stderr: String(outcome.stderr ?? '').trim().slice(-3000),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.platform !== 'win32') {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: `requires Windows, got ${process.platform}` })}\n`);
  process.exit(0);
}

const sandboxExecutable = canonical(process.env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE);
if (!sandboxExecutable) throw new Error('DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE must name the provisioned MXC executable');

const variants = [
  { label: 'lpac-internet', capabilities: ['internetClient'] },
  { label: 'lpac-internet-registry', capabilities: ['internetClient', 'registryRead'] },
  { label: 'lpac-internet-registry-com', capabilities: ['internetClient', 'registryRead', 'lpacCom'] },
  { label: 'lpac-internet-private', capabilities: ['internetClient', 'privateNetworkClientServer'] },
  { label: 'standard-appcontainer-internet', leastPrivilege: false, capabilities: ['internetClient'] },
];

const results = variants.map((variant) => runVariant(sandboxExecutable, variant));
process.stdout.write(`${JSON.stringify({ authoritative: false, results }, null, 2)}\n`);
