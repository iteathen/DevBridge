import { constants } from 'node:fs';
import { access, appendFile, chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCommand } from '../runtime/command-invocation.js';
import { classifyPathVisibility } from './path-visibility.js';

const PROTOCOL = 'devbridge/setup-path-v2';
const OWNED_MARKER = 'DevBridge managed launcher';
const STAGE0_OWNER = 'DevBridge managed Stage 0 source';
const PROFILE_MARKER = '# DevBridge managed PATH';
const MAX_STAGE0_BYTES = 2 * 1024 * 1024;

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

function commandName(platform) {
  return platform === 'win32' ? 'devbridge.cmd' : 'devbridge';
}

function directInvocation(location, platform) {
  if (platform === 'win32') return `& '${location.replaceAll("'", "''")}'`;
  return shellSingleQuote(location);
}

async function installedLauncher(binDirectory) {
  const permanentEntry = path.join(binDirectory, 'devbridge-entry.mjs');
  if (await regularFile(permanentEntry)) return permanentEntry;
  const stage0 = path.join(binDirectory, 'devbridge-stage0.mjs');
  const ownerFile = `${stage0}.owner`;
  if (!await regularFile(stage0) || !await regularFile(ownerFile)) {
    throw new Error('installed DevBridge entry launcher is unavailable');
  }
  if ((await readFile(ownerFile, 'utf8')).trim() !== STAGE0_OWNER) {
    throw new Error('installed Stage 0 source ownership is invalid');
  }
  return stage0;
}

export async function resolveInstalledCommand({
  home,
  platform = process.platform,
} = {}) {
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0') || !path.isAbsolute(home)) {
    throw new TypeError('DevBridge home must be an absolute local path');
  }
  if (!['win32', 'linux', 'darwin'].includes(platform)) {
    throw new Error(`PATH command resolution is unsupported on platform: ${platform}`);
  }
  const binDirectory = path.join(path.resolve(home), 'bin');
  const launcher = await installedLauncher(binDirectory);
  const command = path.join(binDirectory, commandName(platform));
  const expected = platform === 'win32' ? windowsLauncher(launcher) : posixLauncher(launcher);
  const info = await lstat(command);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`installed command is not an owned regular file: ${command}`);
  if (await readFile(command, 'utf8') !== expected) throw new Error(`installed command content is not owned: ${command}`);
  await access(command, constants.R_OK);
  return Object.freeze({
    command,
    binDirectory,
    launcher,
    invocation: directInvocation(command, platform),
  });
}

async function installStage0Source(source, destination) {
  if (typeof source !== 'string' || source.length === 0 || source.includes('\0') || !path.isAbsolute(source)) {
    throw new Error('installed DevBridge entry launcher is unavailable and Stage 0 source authority was not provided');
  }
  const sourcePath = path.resolve(source);
  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 1 || sourceInfo.size > MAX_STAGE0_BYTES) {
    throw new Error('Stage 0 source authority must be a bounded real regular file');
  }
  if (sourcePath === path.resolve(destination)) return destination;

  const ownerFile = `${destination}.owner`;
  if (await regularFile(destination)) {
    if (!await regularFile(ownerFile) || (await readFile(ownerFile, 'utf8')).trim() !== STAGE0_OWNER) {
      throw new Error(`Stage 0 installation collision at ${destination}`);
    }
  } else if (await regularFile(ownerFile)) {
    throw new Error(`Stage 0 ownership marker exists without its managed source: ${ownerFile}`);
  }

  const bytes = await readFile(sourcePath);
  if (bytes.length !== sourceInfo.size) throw new Error('Stage 0 source authority changed during installation');
  await writeFile(ownerFile, `${STAGE0_OWNER}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(destination, bytes, { mode: 0o700 });
  await chmod(destination, 0o700);
  return destination;
}

async function persistWindowsPath(binDirectory, env, invoke) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:DEVBRIDGE_PATH_TARGET
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @()
if ($current) { $parts = @($current -split ';' | Where-Object { $_ -and $_.Trim().Length -gt 0 }) }
$existed = $false
foreach ($part in $parts) {
  if ([String]::Equals([IO.Path]::GetFullPath($part.Trim('"')), [IO.Path]::GetFullPath($target), [StringComparison]::OrdinalIgnoreCase)) { $existed = $true; break }
}
if (-not $existed) {
  $next = if ($current -and $current.Trim().Length -gt 0) { $current.TrimEnd(';') + ';' + $target } else { $target }
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
}
$observed = [Environment]::GetEnvironmentVariable('Path', 'User')
$observedParts = @()
if ($observed) { $observedParts = @($observed -split ';' | Where-Object { $_ -and $_.Trim().Length -gt 0 }) }
$persisted = $false
foreach ($part in $observedParts) {
  if ([String]::Equals([IO.Path]::GetFullPath($part.Trim('"')), [IO.Path]::GetFullPath($target), [StringComparison]::OrdinalIgnoreCase)) { $persisted = $true; break }
}
@{ changed = (-not $existed); persisted = $persisted } | ConvertTo-Json -Compress
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
  const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.keys(parsed).sort((left, right) => left.localeCompare(right))
    : [];
  if (keys.length !== 2 || keys[0] !== 'changed' || keys[1] !== 'persisted'
      || typeof parsed.changed !== 'boolean' || typeof parsed.persisted !== 'boolean') {
    throw new Error('Windows PATH persistence returned invalid structured output');
  }
  return Object.freeze({ changed: parsed.changed, persisted: parsed.persisted });
}

async function persistPosixPath(binDirectory, homeDirectory) {
  const profile = path.join(homeDirectory, '.profile');
  const record = `${PROFILE_MARKER}\nexport PATH=${shellSingleQuote(binDirectory)}:"$PATH"`;
  let text = '';
  try {
    const info = await lstat(profile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`cannot safely update PATH profile: ${profile}`);
    text = await readFile(profile, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (text.includes(PROFILE_MARKER)) {
    return Object.freeze({ changed: false, persisted: text.includes(record) });
  }
  const prefix = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  await appendFile(profile, `${prefix}${record}\n`, { encoding: 'utf8', mode: 0o600 });
  const observed = await readFile(profile, 'utf8');
  return Object.freeze({ changed: true, persisted: observed.includes(record) });
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
  stage0Launcher = null,
  platform = process.platform,
  env = process.env,
  homeDirectory = os.homedir(),
  invoke = invokeCommand,
} = {}) {
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0') || !path.isAbsolute(home)) throw new TypeError('DevBridge home must be an absolute local path');
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error(`PATH installation is unsupported on platform: ${platform}`);
  const binDirectory = path.join(path.resolve(home), 'bin');
  await mkdir(binDirectory, { recursive: true });

  const permanentEntry = path.join(binDirectory, 'devbridge-entry.mjs');
  const launcher = await regularFile(permanentEntry)
    ? permanentEntry
    : await installStage0Source(stage0Launcher, path.join(binDirectory, 'devbridge-stage0.mjs'));

  const collision = await commandCollision(binDirectory, env, platform);
  if (collision) throw new Error(`existing unrelated devbridge command blocks PATH installation: ${collision}`);

  const command = path.join(binDirectory, commandName(platform));
  await assertOwnedOrAbsent(command);
  await writeFile(command, platform === 'win32' ? windowsLauncher(launcher) : posixLauncher(launcher), { encoding: 'utf8', mode: 0o755 });
  if (platform !== 'win32') await chmod(command, 0o755);

  const alreadyVisible = pathContains(binDirectory, env, platform);
  const persistence = platform === 'win32'
    ? await persistWindowsPath(binDirectory, env, invoke)
    : await persistPosixPath(binDirectory, homeDirectory);
  const visibility = classifyPathVisibility({ ...persistence, visible: alreadyVisible });
  if (visibility === 'not-persisted') throw new Error('the installed command directory was not persisted to the user PATH');
  const installed = await resolveInstalledCommand({ home, platform });

  return Object.freeze({
    protocol: PROTOCOL,
    command: installed.command,
    binDirectory: installed.binDirectory,
    launcher: installed.launcher,
    invocation: installed.invocation,
    persisted: persistence.persisted,
    changed: persistence.changed,
    visibility,
  });
}
