import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-elevation-v1';
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
]);
const ALLOWED_LAUNCHERS = new Set(['devbridge-entry.mjs', 'devbridge-stage0.mjs']);

const ELEVATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$env:DEVBRIDGE_HOME = [string]$data.home
$env:DEVBRIDGE_LIFECYCLE_AUTHORITY_ELEVATED_CHILD = '1'
try {
  $launcher = '"' + ([string]$data.launcher).Replace('"', '') + '"'
  $child = Start-Process -FilePath ([string]$data.node) -ArgumentList @(
    $launcher,
    'setup',
    '--lifecycle-authority-child',
    '--no-update'
  ) -Verb RunAs -Wait -PassThru
  @{ started = $true; exitCode = [int]$child.ExitCode } | ConvertTo-Json -Compress
} catch {
  @{ started = $false; exitCode = $null } | ConvertTo-Json -Compress
}
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function invocationSucceeded(result) {
  return result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true && result?.outputTruncated !== true;
}

function absoluteLocalPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('"') || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute local path`);
  }
  return path.resolve(value);
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function boundedRealFile(file, name) {
  const resolved = path.resolve(file);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${name} must be a real regular file`);
  }
  return resolved;
}

async function boundedManagedFile(root, file, name) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (!pathIsWithin(resolvedRoot, resolvedFile)) {
    throw new Error(`${name} escaped the managed DevBridge home`);
  }

  const rootInfo = await lstat(resolvedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`${name} managed root must be a real directory`);
  }
  const canonicalRoot = await realpath(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedFile);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = resolvedRoot;

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${name} must not use filesystem indirection`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`${name} must not traverse a non-directory path`);
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new Error(`${name} must be a real regular file`);
    }
    const canonical = await realpath(current);
    if (!pathIsWithin(canonicalRoot, canonical)) {
      throw new Error(`${name} escaped the managed DevBridge home`);
    }
  }

  return resolvedFile;
}

function samePath(left, right, platform) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function requestWindowsLifecycleAuthorityElevation({
  home,
  launcher,
  platform = process.platform,
  nodeExecutable = process.execPath,
  invoke = invokeCommand,
  environment = process.env,
} = {}) {
  if (platform !== 'win32') return Object.freeze({ protocol: PROTOCOL, attempted: false, completed: true, exitCode: 0, blocker: null });
  if (typeof invoke !== 'function') throw new TypeError('Windows lifecycle authority elevation invocation contract is invalid');
  const root = absoluteLocalPath(home, 'DevBridge elevation home');
  const selectedLauncher = absoluteLocalPath(launcher, 'DevBridge elevation launcher');
  const node = absoluteLocalPath(nodeExecutable, 'DevBridge elevation Node executable');
  const expectedBin = path.join(root, 'bin');
  if (!samePath(path.dirname(selectedLauncher), expectedBin, platform) || !ALLOWED_LAUNCHERS.has(path.basename(selectedLauncher).toLowerCase())) {
    throw new Error('Windows lifecycle authority elevation launcher is outside the managed DevBridge entry boundary');
  }
  await Promise.all([
    boundedManagedFile(root, selectedLauncher, 'Windows lifecycle authority elevation launcher'),
    boundedRealFile(node, 'Windows lifecycle authority elevation Node executable'),
  ]);

  let result;
  try {
    result = await invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(ELEVATE_SCRIPT)],
      input: JSON.stringify({ home: root, launcher: selectedLauncher, node }),
      timeoutMs: 15 * 60_000,
      maxOutputBytes: 64 * 1024,
      environment,
    });
  } catch {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: null,
      blocker: 'Windows lifecycle authority elevation could not be started. Re-run devbridge setup to retry the same protected reconciliation.',
    });
  }

  if (!invocationSucceeded(result)) {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: null,
      blocker: 'Windows lifecycle authority elevation did not complete. Re-run devbridge setup to retry the same protected reconciliation.',
    });
  }

  let value;
  try { value = JSON.parse(String(result.stdout ?? '').trim()); }
  catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.started !== 'boolean'
      || (value.exitCode != null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255))) {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: null,
      blocker: 'Windows lifecycle authority elevation returned invalid bounded status. Re-run devbridge setup to retry the same protected reconciliation.',
    });
  }
  if (value.started !== true) {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: null,
      blocker: 'Windows lifecycle authority elevation was cancelled or refused. No second elevation will be attempted by this setup invocation.',
    });
  }
  if (value.exitCode !== 0) {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: value.exitCode,
      blocker: 'The elevated Windows lifecycle authority child did not complete successfully. Re-run devbridge setup to resume from protected evidence.',
    });
  }
  return Object.freeze({ protocol: PROTOCOL, attempted: true, completed: true, exitCode: 0, blocker: null });
}

export { PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_ELEVATION_PROTOCOL };
