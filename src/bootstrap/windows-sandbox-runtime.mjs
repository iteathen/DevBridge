import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const WINDOWS_SANDBOX_ENGINE = 'windows-appcontainer';
export const WINDOWS_SANDBOX_ENGINE_VERSION = '1';
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const HELPER_COMPILE_TIMEOUT_MS = 60_000;
const HELPER_SOURCE = fileURLToPath(new URL('../runtime/windows-job-launcher.cs', import.meta.url));
const HELPER_FILENAME = 'devbridge-windows-sandbox.exe';
const HELPER_MARKER_FILENAME = 'devbridge-windows-sandbox.sha256';

function fail(message) {
  throw new Error(message);
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

function launcherEnvironment(source = process.env) {
  const result = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
    if (source[name] != null) result[name] = source[name];
  }
  return result;
}

function windowsSandboxRuntimeDirectory(home) {
  return path.join(
    path.resolve(home),
    'sandbox',
    WINDOWS_SANDBOX_ENGINE,
    WINDOWS_SANDBOX_ENGINE_VERSION,
  );
}

export function windowsSandboxExecutablePath(home) {
  return path.join(windowsSandboxRuntimeDirectory(home), HELPER_FILENAME);
}

// Retained as a source-level alias for tests and callers created during the
// Windows sandbox branch. There is now one native helper, not a separate outer
// job launcher and MXC executor.
export function windowsSandboxJobLauncherExecutablePath(home) {
  return windowsSandboxExecutablePath(home);
}

function windowsSandboxHelperMarkerPath(home) {
  return path.join(windowsSandboxRuntimeDirectory(home), HELPER_MARKER_FILENAME);
}

function sourceSha256(source) {
  return createHash('sha256').update(readFileSync(source)).digest('hex');
}

function resolvedWindowsRoot(env = process.env) {
  return path.resolve(env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? 'C:\\Windows');
}

function resolveWindowsCSharpCompiler(env = process.env) {
  const root = resolvedWindowsRoot(env);
  for (const framework of ['Framework64', 'Framework']) {
    const candidate = path.join(root, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function ensureWindowsJobLauncher({
  home,
  env = process.env,
  runner = defaultRunner,
} = {}) {
  if (process.platform !== 'win32') return null;
  if (typeof home !== 'string' || home.trim() === '') fail('Windows sandbox bootstrap requires a DevBridge home directory');
  if (!fileExists(HELPER_SOURCE)) fail(`Windows native sandbox helper source is missing: ${HELPER_SOURCE}`);

  const destination = windowsSandboxExecutablePath(home);
  const marker = windowsSandboxHelperMarkerPath(home);
  const expectedHash = sourceSha256(HELPER_SOURCE);
  let installedHash = null;
  try {
    installedHash = readFileSync(marker, 'utf8').trim();
  } catch {}
  if (fileExists(destination) && installedHash === expectedHash) return destination;

  const compiler = resolveWindowsCSharpCompiler(env);
  if (!compiler) {
    fail('Could not locate the standard Windows .NET Framework C# compiler required to build the DevBridge native AppContainer sandbox helper');
  }

  const destinationDir = path.dirname(destination);
  mkdirSync(destinationDir, { recursive: true });
  const nonce = `${process.pid}.${Date.now()}`;
  const temporaryExecutable = path.join(destinationDir, `${HELPER_FILENAME}.${nonce}.tmp.exe`);
  const temporaryMarker = path.join(destinationDir, `${HELPER_MARKER_FILENAME}.${nonce}.tmp`);
  try {
    checkedCommand(compiler, [
      '/nologo',
      '/target:exe',
      '/platform:anycpu',
      '/optimize+',
      `/out:${temporaryExecutable}`,
      HELPER_SOURCE,
    ], {
      cwd: destinationDir,
      env: launcherEnvironment(env),
      timeout: HELPER_COMPILE_TIMEOUT_MS,
      windowsHide: true,
      stdio: 'pipe',
    }, runner);
    if (!fileExists(temporaryExecutable)) fail('Windows C# compiler did not produce the DevBridge native sandbox helper');

    rmSync(destination, { force: true });
    renameSync(temporaryExecutable, destination);
    writeFileSync(temporaryMarker, `${expectedHash}\n`, { encoding: 'utf8', flag: 'wx' });
    rmSync(marker, { force: true });
    renameSync(temporaryMarker, marker);
    return destination;
  } finally {
    rmSync(temporaryExecutable, { force: true });
    rmSync(temporaryMarker, { force: true });
  }
}

export function ensureWindowsSandboxRuntime({
  home,
  env = process.env,
  runner = defaultRunner,
} = {}) {
  if (process.platform !== 'win32') return null;
  if (typeof home !== 'string' || home.trim() === '') fail('Windows sandbox bootstrap requires a DevBridge home directory');

  const override = env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE;
  let executable;
  if (override) {
    executable = path.resolve(override);
    if (!fileExists(executable)) fail(`DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE does not name a file: ${executable}`);
    if (path.basename(executable).toLowerCase() === 'wxc-exec.exe') {
      fail('Microsoft MXC is no longer a supported DevBridge Windows execution boundary; unset DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE and rerun DevBridge to provision the native AppContainer helper');
    }
  } else {
    executable = ensureWindowsJobLauncher({ home, env, runner });
  }

  checkedCommand(executable, ['--probe'], {
    cwd: path.dirname(executable),
    env: launcherEnvironment(env),
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    stdio: 'pipe',
  }, runner);

  env.DEVBRIDGE_WINDOWS_SANDBOX_EXECUTABLE = executable;
  return executable;
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
