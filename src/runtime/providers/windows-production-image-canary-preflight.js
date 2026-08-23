import { lstat, statfs } from 'node:fs/promises';
import path from 'node:path';
import {
  preflightExecutionProfileMemory,
  preflightExecutionProfileStorage,
} from '../profile-resource-preflight.js';

const PROTOCOL = 'devbridge/production-image-canary-preflight-v1';
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;

const CAPABILITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module Hyper-V -ErrorAction Stop
$required = @(
  'Get-VMHost','Get-VM','New-VM','Remove-VM','Start-VM','Stop-VM','Set-VM','Set-VMProcessor','Set-VMFirmware',
  'Get-VHD','Test-VHD','New-VHD','Get-VMSwitch','New-VMSwitch','Set-VMSwitch','Remove-VMSwitch',
  'Get-NetNat','New-NetNat','Remove-NetNat','Get-NetIPAddress','New-NetIPAddress','Remove-NetIPAddress','Get-NetRoute',
  'Get-VMNetworkAdapter','Add-VMNetworkAdapter','Connect-VMNetworkAdapter','Get-VMDvdDrive','Add-VMDvdDrive','Remove-VMDvdDrive'
)
foreach ($name in $required) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "required management operation is unavailable: $name" }
}
foreach ($name in @('ssh.exe','ssh-keygen.exe','gpgv.exe')) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "required host tool is unavailable: $name" }
}
$null = Get-VMHost -ErrorAction Stop
$null = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
@{ ready = $true } | ConvertTo-Json -Compress
`;

function encodedScript(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

function safeBytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_BYTES) throw new TypeError(`${name} is invalid`);
  return value;
}

function checkedAdd(left, right, name) {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > MAX_SAFE_BYTES) throw new TypeError(`${name} is too large`);
  return value;
}

async function existingDirectory(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError('preflight storage directory is invalid');
  let current = path.resolve(value);
  while (true) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('preflight storage parent must be a real directory');
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error('preflight storage parent is unavailable');
      current = parent;
    }
  }
}

async function regularFile(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is invalid`);
  try {
    const info = await lstat(path.resolve(value));
    if (!info.isFile() || info.isSymbolicLink()) return false;
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function availableBytes(filesystem) {
  const bytes = filesystem.bavail * filesystem.bsize;
  if (typeof bytes === 'bigint') {
    if (bytes < 0n || bytes > BigInt(MAX_SAFE_BYTES)) throw new TypeError('preflight available storage is outside the supported range');
    return Number(bytes);
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('preflight available storage is invalid');
  return bytes;
}

function parseCapability(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    throw new Error(String(result?.stderr || result?.stdout || 'host capability preflight failed').trim().slice(0, 2048));
  }
  let parsed;
  try { parsed = JSON.parse(String(result.stdout ?? '')); } catch { throw new Error('host capability preflight returned invalid structured output'); }
  if (parsed?.ready !== true) throw new Error('host capability preflight did not report readiness');
}

export class WindowsProductionImageCanaryPreflight {
  #invoke;
  #platform;

  constructor({ invoke, platform = process.platform } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('physical canary preflight invocation contract is invalid');
    if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('physical canary preflight platform is invalid');
    this.#invoke = invoke;
    this.#platform = platform;
  }

  async inspect({ stateDirectory, keyring, memoryBytes, diskBytes, sourceBytes } = {}) {
    const requestedMemory = safeBytes(memoryBytes, 'physical canary memoryBytes');
    const requestedDisk = safeBytes(diskBytes, 'physical canary diskBytes');
    const requestedSource = safeBytes(sourceBytes, 'physical canary sourceBytes');
    const reasons = [];
    let memory = null;
    let storage = null;
    let keyringReady = false;
    let providerReady = false;

    try { memory = preflightExecutionProfileMemory({ memoryBytes: requestedMemory }); }
    catch (error) { reasons.push(error.message); }

    try {
      const probe = await existingDirectory(stateDirectory);
      const filesystem = await statfs(probe, { bigint: true });
      const twoDisks = checkedAdd(requestedDisk, requestedDisk, 'physical canary peak storage');
      const peakBytes = checkedAdd(twoDisks, requestedSource, 'physical canary peak storage');
      storage = preflightExecutionProfileStorage({ sourceBytes: peakBytes }, { availableBytes: availableBytes(filesystem) });
    } catch (error) { reasons.push(error.message); }

    try { keyringReady = await regularFile(keyring, 'physical canary signature keyring'); }
    catch (error) { reasons.push(error.message); }
    if (!keyringReady) reasons.push('physical canary signature keyring is unavailable');

    if (this.#platform !== 'win32') {
      reasons.push('physical production image canary requires a Windows Hyper-V host');
    } else {
      try {
        parseCapability(await this.#invoke({
          executable: POWERSHELL,
          arguments: [...POWERSHELL_ARGS, encodedScript(CAPABILITY_SCRIPT)],
          input: null,
          timeoutMs: 30_000,
          maxOutputBytes: 256 * 1024,
        }));
        providerReady = true;
      } catch (error) { reasons.push(error.message); }
    }

    const ready = reasons.length === 0;
    return Object.freeze({
      protocol: PROTOCOL,
      ready,
      reason: ready ? null : Object.freeze([...new Set(reasons)]).join('; '),
      platform: this.#platform,
      capabilities: Object.freeze({ provider: providerReady, keyring: keyringReady, memory: memory != null, storage: storage != null }),
      resources: Object.freeze({ memory, storage }),
    });
  }
}

export function createWindowsProductionImageCanaryPreflight(options) {
  return new WindowsProductionImageCanaryPreflight(options);
}
