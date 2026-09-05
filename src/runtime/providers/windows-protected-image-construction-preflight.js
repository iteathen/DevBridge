import { lstat, statfs } from 'node:fs/promises';
import path from 'node:path';
import {
  preflightExecutionProfileMemory,
  preflightExecutionProfileStorage,
} from '../profile-resource-preflight.js';
import { createWindowsManagedConstructionNetwork } from './windows-managed-construction-network.js';

export const WINDOWS_PROTECTED_IMAGE_CONSTRUCTION_PREFLIGHT_PROTOCOL = 'devbridge/windows-protected-image-construction-preflight-v1';

const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;

const CAPABILITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module Hyper-V -ErrorAction Stop
$required = @(
  'Get-VMHost','Get-VM','New-VM','Remove-VM','Start-VM','Stop-VM','Set-VM','Set-VMProcessor','Set-VMFirmware',
  'Set-VMKeyProtector','Enable-VMTPM','Get-VHD','Test-VHD','New-VHD','Get-VMSwitch','Get-VMHardDiskDrive','Add-VMHardDiskDrive',
  'Get-VMNetworkAdapter','Add-VMNetworkAdapter','Connect-VMNetworkAdapter','Get-VMDvdDrive','Add-VMDvdDrive','Remove-VMDvdDrive',
  'Get-VMIntegrationService','Enable-VMIntegrationService'
)
foreach ($name in $required) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "required management operation is unavailable: $name" }
}
$null = Get-VMHost -ErrorAction Stop
$null = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
@{ ready = $true } | ConvertTo-Json -Compress
`;

function encodedScript(source) { return Buffer.from(source, 'utf16le').toString('base64'); }

function bytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SAFE_BYTES) throw new TypeError(`${name} is invalid`);
  return value;
}

function checkedAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > MAX_SAFE_BYTES) throw new TypeError('protected image construction peak storage is too large');
  return result;
}

async function existingDirectory(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError('protected image construction storage directory is invalid');
  let current = path.resolve(value);
  while (true) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('protected image construction storage parent must be a real directory');
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error('protected image construction storage parent is unavailable');
      current = parent;
    }
  }
}

function availableBytes(filesystem) {
  const value = filesystem.bavail * filesystem.bsize;
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(MAX_SAFE_BYTES)) throw new TypeError('protected image construction available storage is outside the supported range');
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('protected image construction available storage is invalid');
  return value;
}

function parseCapability(raw) {
  if (!raw || raw.exitCode !== 0 || raw.timedOut || raw.aborted || raw.outputTruncated) throw new Error('protected image construction capability probe failed');
  let value;
  try { value = JSON.parse(String(raw.stdout ?? '')); } catch { throw new Error('protected image construction capability probe returned invalid output'); }
  if (value?.ready !== true) throw new Error('protected image construction capability probe did not report readiness');
}

export class WindowsProtectedImageConstructionPreflight {
  #invoke;
  #platform;
  #network;

  constructor({ invoke, platform = process.platform, network = null } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('protected image construction invocation contract is invalid');
    if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('protected image construction platform is invalid');
    this.#invoke = invoke;
    this.#platform = platform;
    this.#network = network ?? (platform === 'win32' ? createWindowsManagedConstructionNetwork({ invoke }) : null);
    if (this.#network != null && typeof this.#network.inspect !== 'function') throw new TypeError('protected image construction network contract is incomplete');
  }

  async inspect({ stateDirectory, memoryBytes, diskBytes, allocationBytes, sourceBytes } = {}) {
    const requestedMemory = bytes(memoryBytes, 'protected image construction memoryBytes');
    const requestedDisk = bytes(diskBytes, 'protected image construction diskBytes');
    const requestedAllocation = bytes(allocationBytes, 'protected image construction allocationBytes');
    if (requestedAllocation > requestedDisk) throw new TypeError('protected image construction allocationBytes exceeds virtual disk capacity');
    const requestedSource = bytes(sourceBytes, 'protected image construction sourceBytes');
    const reasons = [];
    let memory = null;
    let storage = null;
    let providerReady = false;
    let connectivity = null;
    try { memory = preflightExecutionProfileMemory({ memoryBytes: requestedMemory }); }
    catch (error) { reasons.push(error.message); }
    try {
      const probe = await existingDirectory(stateDirectory);
      const filesystem = await statfs(probe, { bigint: true });
      const peakBytes = checkedAdd(checkedAdd(requestedAllocation, requestedAllocation), requestedSource);
      storage = preflightExecutionProfileStorage({ sourceBytes: peakBytes }, { availableBytes: availableBytes(filesystem) });
    } catch (error) { reasons.push(error.message); }
    if (this.#platform !== 'win32') reasons.push('protected image construction requires a Windows virtualization host');
    else {
      try {
        parseCapability(await this.#invoke({
          executable: POWERSHELL,
          arguments: [...POWERSHELL_ARGS, encodedScript(CAPABILITY_SCRIPT)],
          input: null,
          timeoutMs: 30_000,
          maxOutputBytes: 256 * 1024,
        }));
        providerReady = true;
        connectivity = await this.#network.inspect();
        if (connectivity?.ready !== true) throw new Error(connectivity?.reason ?? 'protected image construction network is unavailable');
      } catch (error) { reasons.push(String(error?.message ?? error).slice(0, 2048)); }
    }
    const ready = reasons.length === 0;
    return Object.freeze({
      protocol: WINDOWS_PROTECTED_IMAGE_CONSTRUCTION_PREFLIGHT_PROTOCOL,
      ready,
      reason: ready ? null : [...new Set(reasons)].join('; '),
      platform: this.#platform,
      capabilities: Object.freeze({ provider: providerReady, connectivity: connectivity?.ready === true, memory: memory != null, storage: storage != null }),
      connectivity: connectivity?.ready === true
        ? Object.freeze({ control: connectivity.description.binding.control, addressing: connectivity.description.addressing.method })
        : null,
      resources: Object.freeze({ memory, storage }),
    });
  }
}

export function createWindowsProtectedImageConstructionPreflight(options) {
  return new WindowsProtectedImageConstructionPreflight(options);
}
