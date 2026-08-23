import { constants } from 'node:fs';
import { access, appendFile, chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/setup-path-v1';
const OWNED_MARKER = 'DevBridge managed launcher';
const PROFILE_MARKER = '# DevBridge managed PATH';

async function regularFile(location) {
  try {
    const info = await lstat(location);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function commandCollision(binDirectory, env, platform) {
  const current = String(env.PATH ?? env.Path ?? env.path ?? '');
  if (current.length === 0) return null;
  const owned = path.resolve(binDirectory);
  const extensions = platform === 'win32'
    ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const segment of current.split(path.delimiter).filter(Boolean)) {
    const directory = path.resolve(segment.replace(/^"|"$/gu, ''));
    if (platform === 'win32' ? directory.toLowerCase() === owned.toLowerCase() : directory === owned) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `devbridge${extension.toLowerCase()}`);
      if (await regularFile(candidate)) return candidate;
      if (platform === 'win32') {
        const originalCase = path.join(directory, `devbridge${extension}`);
        if (originalCase !== candidate && await regularFile(originalCase)) return originalCase;
      }
    }
  }
  return null;
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function windowsLauncher(entry) {
  return `@echo off\r\nrem ${OWNED_MARKER}\r\nnode "${entry.replaceAll('"', '""')}" %*\r\n`;
}

function posixLauncher(entry) {
  return `#!/bin/sh\n# ${OWNED_MARKER}\nexec node ${shellSingleQuote(entry)} "$@"\n`;
}

async function assertOwnedOrAbsent(location) {
  try {
    const info = await lstat(location);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`PATH launcher target is not an owned regular file: ${location}`);
    const text = await readFile(location, 'utf8');
    if (!text.includes(OWNED_MARKER)) throw new Error(`PATH launcher collision at ${location}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function persistWindowsPath(binDirectory, env, invoke) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:DEVBRIDGE_PATH_TARGET
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @()
if ($current) { $parts = @($current -split ';' | Where-Object { $_ -and $_.Trim().Length -gt 0 }) }
$exists = $false
foreach ($part in $parts) {
  if ([String]::Equals([IO.Path]::GetFullPath($part.Trim('"')), [IO.Path]::GetFullPath($target), [StringComparison]::OrdinalIgnoreCase)) { $exists = $true; break }
}
if (-not $exists) {
  $next = if ($current -and $current.Trim().Length -gt 0) { $current.TrimEnd(';') + ';' + $target } else { $target }
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
}
@{ changed = (-not $exists) } | ConvertTo-Json -Compress
`;
  const result = await invoke({
    executable: 'powershell.exe',
    arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    input: null,
    environment: { ...env, DEVBRIDGE_PATH_TARGET: binDirectory },
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    throw new Error(String(result?.stderr || result?.stdout || 'failed to persist the DevBridge user PATH').trim().slice(0, 2048));
  }
  let parsed;
  try { parsed = JSON.parse(String(result.stdout ?? '').trim()); } catch { throw new Error('Windows PATH persistence returned invalid structured output'); }
  return parsed?.changed === true;
}

async function persistPosixPath(binDirectory, homeDirectory) {
  const profile = path.join(homeDirectory, '.profile');
  let text = '';
  try {
    const info = await lstat(profile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`cannot safely update PATH profile: ${profile}`);
    text = await readFile(profile, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (text.includes(PROFILE_MARKER)) return false;
  const prefix = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  await appendFile(profile, `${prefix}${PROFILE_MARKER}\nexport PATH=${shellSingleQuote(binDirectory)}:"$PATH"\n`, { encoding: 'utf8', mode: 0o600 });
  return true;
}

function pathContains(binDirectory, env, platform) {
  const current = String(env.PATH ?? env.Path ?? env.path ?? '');
  const target = path.resolve(binDirectory);
  return current.split(path.delimiter).filter(Boolean).some((segment) => {
    const candidate = path.resolve(segment.replace(/^"|"$/gu, ''));
    return platform === 'win32' ? candidate.toLowerCase() === target.toLowerCase() : candidate === target;
  });
}

export async function installStableDevBridgeCommand({
  home,
  platform = process.platform,
  env = process.env,
  homeDirectory = os.homedir(),
  invoke = invokeCommand,
} = {}) {
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0') || !path.isAbsolute(home)) throw new TypeError('DevBridge home must be an absolute local path');
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error(`PATH installation is unsupported on platform: ${platform}`);
  const binDirectory = path.join(path.resolve(home), 'bin');
  const entry = path.join(binDirectory, 'devbridge-entry.mjs');
  if (!await regularFile(entry)) throw new Error(`installed DevBridge entry launcher is unavailable: ${entry}`);

  const collision = await commandCollision(binDirectory, env, platform);
  if (collision) throw new Error(`existing unrelated devbridge command blocks PATH installation: ${collision}`);

  await mkdir(binDirectory, { recursive: true });
  const command = platform === 'win32' ? path.join(binDirectory, 'devbridge.cmd') : path.join(binDirectory, 'devbridge');
  await assertOwnedOrAbsent(command);
  await writeFile(command, platform === 'win32' ? windowsLauncher(entry) : posixLauncher(entry), { encoding: 'utf8', mode: 0o755 });
  if (platform !== 'win32') await chmod(command, 0o755);
  await access(command, constants.R_OK);

  const alreadyVisible = pathContains(binDirectory, env, platform);
  const changed = platform === 'win32'
    ? await persistWindowsPath(binDirectory, env, invoke)
    : await persistPosixPath(binDirectory, homeDirectory);

  return Object.freeze({
    protocol: PROTOCOL,
    command,
    binDirectory,
    persisted: true,
    changed,
    requiresNewShell: !alreadyVisible,
    temporaryCommand: !alreadyVisible ? `${process.execPath} ${JSON.stringify(entry)}` : null,
  });
}
