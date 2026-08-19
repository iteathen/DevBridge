import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const WINDOWS_SANDBOX_PACKAGE = '@microsoft/mxc-sdk';
export const WINDOWS_SANDBOX_PACKAGE_VERSION = '0.7.0';
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;

function fail(message) {
  throw new Error(message);
}

function sdkArch(arch = process.arch) {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'x64';
  fail(`Windows sandbox runtime does not support Node architecture ${arch}`);
}

function defaultRunner(executable, args, options) {
  return spawnSync(executable, args, {
    ...options,
    shell: false,
    encoding: 'utf8',
    maxBuffer: CAPTURE_LIMIT,
  });
}

function commandFailure(label, result) {
  const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
  return `${label} failed (exit ${result.status ?? 'spawn-error'})${detail ? `: ${detail.slice(-4000)}` : ''}`;
}

function checkedCommand(executable, args, options, runner) {
  const result = runner(executable, args, options);
  if (result?.error || result?.status !== 0) fail(commandFailure(`${executable} ${args.join(' ')}`, result ?? {}));
  return result;
}

function fileExists(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function windowsSandboxExecutablePath(home, { arch = process.arch } = {}) {
  return path.join(path.resolve(home), 'sandbox', 'mxc', WINDOWS_SANDBOX_PACKAGE_VERSION, 'wxc-exec.exe');
}

export function ensureWindowsSandboxRuntime({
  home,
  env = process.env,
  runner = defaultRunner,
  arch = process.arch,
} = {}) {
  if (process.platform !== 'win32') return null;
  if (typeof home !== 'string' || home.trim() === '') fail('Windows sandbox bootstrap requires a DevBridge home directory');

  const override = env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE;
  if (override) {
    const resolved = path.resolve(override);
    if (!fileExists(resolved)) fail(`DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE does not name a file: ${resolved}`);
    env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE = resolved;
    return resolved;
  }

  const destination = windowsSandboxExecutablePath(home, { arch });
  if (fileExists(destination)) {
    env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE = destination;
    return destination;
  }

  const sandboxRoot = path.join(path.resolve(home), 'sandbox');
  const stage = path.join(sandboxRoot, `.mxc-stage-${process.pid}-${Date.now()}`);
  const destinationDir = path.dirname(destination);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  mkdirSync(stage, { recursive: true });

  try {
    checkedCommand(npm, [
      'install',
      '--prefix', stage,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--omit=optional',
      `${WINDOWS_SANDBOX_PACKAGE}@${WINDOWS_SANDBOX_PACKAGE_VERSION}`,
    ], {
      cwd: stage,
      env,
      timeout: INSTALL_TIMEOUT_MS,
      windowsHide: true,
      stdio: 'pipe',
    }, runner);

    const source = path.join(
      stage,
      'node_modules',
      '@microsoft',
      'mxc-sdk',
      'bin',
      sdkArch(arch),
      'wxc-exec.exe',
    );
    if (!fileExists(source)) fail(`pinned MXC package did not contain expected runtime: ${source}`);

    mkdirSync(destinationDir, { recursive: true });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    copyFileSync(source, temporary);
    if (fileExists(destination)) rmSync(temporary, { force: true });
    else renameSync(temporary, destination);

    checkedCommand(destination, ['--probe'], {
      cwd: destinationDir,
      env: {},
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: 'pipe',
    }, runner);

    env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE = destination;
    return destination;
  } catch (error) {
    fail(
      `Could not provision the pinned Windows sandbox runtime ${WINDOWS_SANDBOX_PACKAGE}@${WINDOWS_SANDBOX_PACKAGE_VERSION}: ${error?.message ?? error}. ` +
      'Install/repair Node.js npm access, then rerun DevBridge; repository-code execution remains disabled until provisioning and the live boundary probe both succeed.',
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  let home = process.env.DEVBRIDGE_HOME || path.join(homedir(), '.devbridge');
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--home' || !argv[index + 1]) fail(`unknown Windows sandbox bootstrap argument: ${argv[index]}`);
    home = argv[index + 1];
    index += 1;
  }
  return { home: path.resolve(home) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const executable = ensureWindowsSandboxRuntime(parseCli(process.argv.slice(2)));
    if (executable) process.stdout.write(`${executable}\n`);
  } catch (error) {
    process.stderr.write(`[devbridge-windows-sandbox] ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
