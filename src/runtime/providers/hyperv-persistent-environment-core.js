import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeBootProtection } from '../../values/boot-protection.js';

const PROTOCOL = 'devbridge/hyperv-persistent-environment-v1';
const TOKEN = /^[a-f0-9]{32}$/u;
const ENVIRONMENT = /^env-[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PROVIDER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const POWERSHELL = 'powershell.exe';
const COMMAND_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const MIN_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_PROCESSORS = 256;
const TRUST_TEMPLATES = Object.freeze({ 'platform-owner': 'MicrosoftWindows' });

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function normalizeSettings(raw) {
  const value = requireObject(raw, 'environment settings');
  onlyKeys(value, new Set(['memoryBytes', 'processorCount', 'firmware', 'bootProtection']), 'environment settings');
  if (!Number.isSafeInteger(value.memoryBytes) || value.memoryBytes < MIN_MEMORY_BYTES || value.memoryBytes > MAX_MEMORY_BYTES) throw new TypeError('environment settings.memoryBytes is invalid');
  if (!Number.isSafeInteger(value.processorCount) || value.processorCount < 1 || value.processorCount > MAX_PROCESSORS) throw new TypeError('environment settings.processorCount is invalid');
  if (!['efi', 'bios'].includes(value.firmware)) throw new TypeError('environment settings.firmware is invalid');
  const bootProtection = normalizeBootProtection(value.bootProtection, { optional: true, name: 'environment settings.bootProtection' });
  if (bootProtection && value.firmware !== 'efi') throw new TypeError('environment protected boot requires EFI firmware');
  const settings = { memoryBytes: value.memoryBytes, processorCount: value.processorCount, firmware: value.firmware };
  if (bootProtection) settings.bootProtection = bootProtection;
  return settings;
}

function providerBootSettings(settings) {
  const protection = settings.bootProtection ?? null;
  return {
    integrityRequired: protection?.integrity === 'required',
    identityRequired: protection?.identity === 'required',
    trustTemplate: protection ? TRUST_TEMPLATES[protection.trust] : null,
  };
}

function encodeScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function parseJson(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    const detail = result?.stderr?.trim() || result?.stdout?.trim() || 'environment management operation failed';
    throw new Error(detail.slice(0, 2048));
  }
  try { return JSON.parse(result.stdout); } catch { throw new Error('environment management operation returned invalid structured output'); }
}

function ownedName(identity, value) {
  return `db-env-${createHash('sha256').update(`${identity}:persistent:${value}`).digest('hex').slice(0, 16)}`;
}

function marker(identity, value) {
  return `devbridge-owned:${identity}:persistent:${value}:v1`;
}

function bindingIdentity(identity) {
  return createHash('sha256').update(`${identity}:persistent-environment:hyperv:v1`).digest('hex').slice(0, 32);
}

function emptyState() { return { protocol: PROTOCOL, records: {} }; }

function fileIdentity(info) {
  return { device: String(info.dev), inode: String(info.ino), createdNs: String(info.birthtimeNs ?? 0n) };
}
function sameFileIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode && left?.createdNs === right?.createdNs;
}

function normalizedObservation(identity, raw, sourceIdentity = null) {
  const exists = raw?.exists === true;
  const owned = raw?.owned === true;
  const compatible = raw?.compatible === true;
  return {
    identity,
    exists,
    owned,
    compatible,
    state: String(raw?.state ?? (exists ? 'unknown' : 'absent')).toLowerCase(),
    reason: raw?.reason == null ? null : String(raw.reason),
    storage: raw?.storageIdentity == null ? null : {
      identity: String(raw.storageIdentity),
      sourceIdentity,
      allocatedBytes: Number.isSafeInteger(Number(raw.allocatedBytes)) ? Number(raw.allocatedBytes) : null,
    },
  };
}

const OBSERVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
$diskExists = Test-Path -LiteralPath $data.diskPath -PathType Leaf
if ($null -eq $item -and -not $diskExists) {
  @{ exists = $false; owned = $false; compatible = $false; state = 'absent'; reason = 'owned environment objects are absent' } | ConvertTo-Json -Compress
  exit 0
}
if ($null -eq $item) {
  @{ exists = $false; owned = $true; compatible = $false; state = 'incomplete'; reason = 'environment configuration is absent while writable state remains' } | ConvertTo-Json -Compress
  exit 0
}
$actualIdentity = ([string]$item.Id).ToLowerInvariant()
if (-not [string]::IsNullOrWhiteSpace([string]$data.providerIdentity) -and $actualIdentity -ne ([string]$data.providerIdentity).ToLowerInvariant()) {
  @{ exists = $true; owned = $false; compatible = $false; state = ([string]$item.State).ToLowerInvariant(); reason = 'environment provider identity does not match' } | ConvertTo-Json -Compress
  exit 0
}
$owned = ([string]$item.Notes -eq [string]$data.marker)
if (-not $owned) {
  @{ exists = $true; owned = $false; compatible = $false; state = ([string]$item.State).ToLowerInvariant(); reason = 'environment ownership evidence does not match' } | ConvertTo-Json -Compress
  exit 0
}
$expectedGeneration = if ([string]$data.firmware -eq 'bios') { 1 } else { 2 }
if ([int]$item.Generation -ne $expectedGeneration) {
  @{ exists = $true; owned = $true; compatible = $false; state = ([string]$item.State).ToLowerInvariant(); reason = 'environment firmware generation does not match' } | ConvertTo-Json -Compress
  exit 0
}
$security = Get-VMSecurity -VMName $data.name -ErrorAction Stop
$identityMatches = [bool]$security.TpmEnabled -eq [bool]$data.identityRequired
if (-not $identityMatches) {
  @{ exists = $true; owned = $true; compatible = $false; state = ([string]$item.State).ToLowerInvariant(); reason = 'environment protected identity does not match' } | ConvertTo-Json -Compress
  exit 0
}
if ($expectedGeneration -eq 2) {
  $firmware = Get-VMFirmware -VMName $data.name -ErrorAction Stop
  $integrityEnabled = [string]$firmware.SecureBoot -eq 'On'
  $integrityMatches = $integrityEnabled -eq [bool]$data.integrityRequired
  if ($data.integrityRequired -eq $true) {
    $integrityMatches = $integrityMatches -and [string]$firmware.SecureBootTemplate -eq [string]$data.trustTemplate
  }
  if (-not $integrityMatches) {
    @{ exists = $true; owned = $true; compatible = $false; state = ([string]$item.State).ToLowerInvariant(); reason = 'environment firmware integrity does not match' } | ConvertTo-Json -Compress
    exit 0
  }
}
if (-not $diskExists) {
  @{ exists = $true; owned = $true; compatible = $false; state = ([string]$item.State).ToLowerInvariant(); reason = 'environment writable state is missing' } | ConvertTo-Json -Compress
  exit 0
}
if (-not (Test-VHD -Path $data.diskPath -ErrorAction Stop)) {
  @{ exists = $true; owned = $true; compatible = $false; state = ([string]$item.State).ToLowerInvariant(); reason = 'environment writable state is unusable' } | ConvertTo-Json -Compress
  exit 0
}
$disk = Get-VHD -Path $data.diskPath -ErrorAction Stop
$actualParent = if ([string]::IsNullOrWhiteSpace([string]$disk.ParentPath)) { $null } else { [IO.Path]::GetFullPath([string]$disk.ParentPath) }
$expectedParent = [IO.Path]::GetFullPath([string]$data.parentPath)
if ([string]$disk.VhdType -ne 'Differencing' -or $actualParent -ne $expectedParent) {
  @{ exists = $true; owned = $true; compatible = $false; state = ([string]$item.State).ToLowerInvariant(); reason = 'environment writable lineage does not match' } | ConvertTo-Json -Compress
  exit 0
}
$attached = @(Get-VMHardDiskDrive -VMName $data.name -ErrorAction Stop | Where-Object { [IO.Path]::GetFullPath([string]$_.Path) -eq [IO.Path]::GetFullPath([string]$data.diskPath) })
if ($attached.Count -ne 1) {
  @{ exists = $true; owned = $true; compatible = $false; state = ([string]$item.State).ToLowerInvariant(); reason = 'environment storage attachment does not match' } | ConvertTo-Json -Compress
  exit 0
}
@{
  exists = $true
  owned = $true
  compatible = $true
  state = ([string]$item.State).ToLowerInvariant()
  storageIdentity = if ($null -eq $disk.DiskIdentifier) { [IO.Path]::GetFileName([string]$data.diskPath) } else { [string]$disk.DiskIdentifier }
  allocatedBytes = [long]$disk.FileSize
} | ConvertTo-Json -Compress
`;

const STORAGE_INSPECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
if (-not (Test-Path -LiteralPath $data.diskPath -PathType Leaf)) {
  @{ compatible = $false; reason = 'environment writable state is absent' } | ConvertTo-Json -Compress
  exit 0
}
if (-not (Test-VHD -Path $data.diskPath -ErrorAction Stop)) {
  @{ compatible = $false; reason = 'environment writable state is unusable' } | ConvertTo-Json -Compress
  exit 0
}
$disk = Get-VHD -Path $data.diskPath -ErrorAction Stop
$actualParent = if ([string]::IsNullOrWhiteSpace([string]$disk.ParentPath)) { $null } else { [IO.Path]::GetFullPath([string]$disk.ParentPath) }
$expectedParent = [IO.Path]::GetFullPath([string]$data.parentPath)
if ([string]$disk.VhdType -ne 'Differencing' -or $actualParent -ne $expectedParent) {
  @{ compatible = $false; reason = 'environment writable lineage does not match' } | ConvertTo-Json -Compress
  exit 0
}
@{ compatible = $true; reason = $null } | ConvertTo-Json -Compress
`;

const PROVISION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$null = New-Item -ItemType Directory -Path $data.configPath -Force -ErrorAction Stop
if (-not (Test-Path -LiteralPath $data.diskPath -PathType Leaf)) {
  $null = New-VHD -Path $data.diskPath -ParentPath $data.parentPath -Differencing -ErrorAction Stop
}
if (-not (Test-VHD -Path $data.diskPath -ErrorAction Stop)) { throw 'environment writable state is unusable' }
$disk = Get-VHD -Path $data.diskPath -ErrorAction Stop
$actualParent = if ([string]::IsNullOrWhiteSpace([string]$disk.ParentPath)) { $null } else { [IO.Path]::GetFullPath([string]$disk.ParentPath) }
if ([string]$disk.VhdType -ne 'Differencing' -or $actualParent -ne [IO.Path]::GetFullPath([string]$data.parentPath)) { throw 'environment writable lineage does not match' }
$vmGeneration = if ([string]$data.firmware -eq 'bios') { 1 } else { 2 }
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -eq $item) {
  $item = New-VM -Name $data.name -MemoryStartupBytes ([long]$data.memoryBytes) -Generation $vmGeneration -VHDPath $data.diskPath -Path $data.configPath -ErrorAction Stop
  $item = Get-VM -Name $data.name -ErrorAction Stop
}
$actualIdentity = ([string]$item.Id).ToLowerInvariant()
if (-not [string]::IsNullOrWhiteSpace([string]$data.providerIdentity) -and $actualIdentity -ne ([string]$data.providerIdentity).ToLowerInvariant()) {
  throw 'environment provider identity does not match'
}
$attached = @(Get-VMHardDiskDrive -VMName $data.name -ErrorAction Stop)
$attachedMatches = $attached.Count -eq 1 -and [IO.Path]::GetFullPath([string]$attached[0].Path) -eq [IO.Path]::GetFullPath([string]$data.diskPath)
$alreadyOwned = [string]$item.Notes -eq [string]$data.marker
if (-not $alreadyOwned) {
  # A crash may occur after New-VM commits but before the ownership marker is
  # written. Only adopt that exact partial effect when it has no foreign marker
  # and already points at the pre-recorded owned writable disk.
  if (-not [string]::IsNullOrWhiteSpace([string]$item.Notes) -or -not $attachedMatches) {
    throw 'environment name is occupied without matching ownership evidence'
  }
} elseif (-not $attachedMatches) {
  throw 'environment storage attachment does not match'
}
$expectedGeneration = if ([string]$data.firmware -eq 'bios') { 1 } else { 2 }
if ([int]$item.Generation -ne $expectedGeneration) { throw 'environment firmware generation does not match' }
$security = Get-VMSecurity -VMName $data.name -ErrorAction Stop
if ($alreadyOwned) {
  if ([bool]$security.TpmEnabled -ne [bool]$data.identityRequired) { throw 'environment protected identity does not match' }
  if ($expectedGeneration -eq 2) {
    $firmware = Get-VMFirmware -VMName $data.name -ErrorAction Stop
    $integrityMatches = ([string]$firmware.SecureBoot -eq 'On') -eq [bool]$data.integrityRequired
    if ($data.integrityRequired -eq $true) { $integrityMatches = $integrityMatches -and [string]$firmware.SecureBootTemplate -eq [string]$data.trustTemplate }
    if (-not $integrityMatches) { throw 'environment firmware integrity does not match' }
  }
} else {
  if ($expectedGeneration -eq 2) {
    if ($data.integrityRequired -eq $true) { Set-VMFirmware -VMName $data.name -EnableSecureBoot On -SecureBootTemplate ([string]$data.trustTemplate) -ErrorAction Stop }
    else { Set-VMFirmware -VMName $data.name -EnableSecureBoot Off -ErrorAction Stop }
  }
  if ($data.identityRequired -eq $true -and -not [bool]$security.TpmEnabled) {
    Set-VMKeyProtector -VMName $data.name -NewLocalKeyProtector -ErrorAction Stop
    Enable-VMTPM -VMName $data.name -ErrorAction Stop
  } elseif ($data.identityRequired -ne $true -and [bool]$security.TpmEnabled) {
    throw 'environment protected identity does not match'
  }
}
Set-VM -Name $data.name -Notes $data.marker -AutomaticCheckpointsEnabled $false -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -ErrorAction Stop
Set-VMProcessor -VMName $data.name -Count ([long]$data.processorCount) -ErrorAction Stop
@{ ready = $true; providerIdentity = $actualIdentity } | ConvertTo-Json -Compress
`;

const START_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -eq $item) { throw 'environment is absent' }
if (-not [string]::IsNullOrWhiteSpace([string]$data.providerIdentity) -and ([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'environment provider identity does not match' }
if ([string]$item.Notes -ne [string]$data.marker) { throw 'environment ownership evidence does not match' }
if ([string]$item.State -eq 'Off') { $null = Start-VM -Name $data.name -ErrorAction Stop }
@{ changed = $true } | ConvertTo-Json -Compress
`;

const STOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -eq $item) { @{ changed = $false } | ConvertTo-Json -Compress; exit 0 }
if (-not [string]::IsNullOrWhiteSpace([string]$data.providerIdentity) -and ([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'environment provider identity does not match' }
if ([string]$item.Notes -ne [string]$data.marker) { throw 'environment ownership evidence does not match' }
if ([string]$item.State -ne 'Off') {
  if ($data.force -eq $true) { Stop-VM -Name $data.name -TurnOff -Confirm:$false -ErrorAction Stop }
  else { Stop-VM -Name $data.name -Shutdown -Confirm:$false -ErrorAction Stop }
}
@{ changed = $true } | ConvertTo-Json -Compress
`;

const REMOVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -eq $item) { @{ removed = $false; absent = $true } | ConvertTo-Json -Compress; exit 0 }
if (-not [string]::IsNullOrWhiteSpace([string]$data.providerIdentity) -and ([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'environment provider identity does not match' }
if ([string]$item.Notes -ne [string]$data.marker) { throw 'environment ownership evidence does not match' }
if ([string]$item.State -ne 'Off') { throw 'environment must be stopped before removal' }
Remove-VM -Name $data.name -Force -ErrorAction Stop
@{ removed = $true; absent = $false } | ConvertTo-Json -Compress
`;

export class HyperVPersistentEnvironment {
  #directory;
  #sourceRoot;
  #identity;
  #invoke;
  #stateFile;

  constructor({ directory, sourceRoot, identity, invoke }) {
    if (typeof identity !== 'string' || !TOKEN.test(identity)) throw new TypeError('environment identity is invalid');
    if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
    this.#directory = path.resolve(directory);
    this.#sourceRoot = path.resolve(sourceRoot);
    this.#identity = identity;
    this.#invoke = invoke;
    this.#stateFile = path.join(this.#directory, 'state.json');
  }

  async #ensure() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment storage root must be a real directory');
    const objects = path.join(this.#directory, 'objects');
    await mkdir(objects, { recursive: true, mode: 0o700 });
    const objectInfo = await lstat(objects);
    if (!objectInfo.isDirectory() || objectInfo.isSymbolicLink()) throw new Error('environment object root must be a real directory');
  }

  async #load() {
    await this.#ensure();
    try {
      const info = await lstat(this.#stateFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment adapter state must be a real file');
      const state = JSON.parse(await readFile(this.#stateFile, 'utf8'));
      if (!state || state.protocol !== PROTOCOL || !state.records) throw new Error('environment adapter state is invalid');
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async #save(state) {
    await this.#ensure();
    const temporary = path.join(this.#directory, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.#stateFile);
  }

  async #run(script, payload, timeoutMs = 60_000) {
    return parseJson(await this.#invoke({
      executable: POWERSHELL,
      arguments: [...COMMAND_ARGS, encodeScript(script)],
      input: JSON.stringify(payload),
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
    }));
  }

  #descriptor(identity) {
    if (typeof identity !== 'string' || !ENVIRONMENT.test(identity)) throw new TypeError('environment identity is invalid');
    const local = path.join(this.#directory, 'objects', identity);
    return {
      name: ownedName(this.#identity, identity),
      marker: marker(this.#identity, identity),
      local,
      configPath: path.join(local, 'machine'),
    };
  }

  #record(state, identity) {
    const record = state.records[identity];
    if (!record) return null;
    const descriptor = this.#descriptor(identity);
    if (record.identity !== identity || !SAFE_ID.test(String(record.sourceIdentity ?? ''))) throw new Error('environment adapter record identity is invalid');
    if (!['vhd', 'vhdx'].includes(record.diskFormat)) throw new Error('environment adapter record format is invalid');
    if (record.providerIdentity != null && !PROVIDER_ID.test(String(record.providerIdentity))) throw new Error('environment adapter provider identity is invalid');
    const expectedDisk = path.join(descriptor.local, `state.${record.diskFormat}`);
    if (path.resolve(record.diskPath) !== expectedDisk || path.resolve(record.configPath) !== descriptor.configPath || record.name !== descriptor.name || record.marker !== descriptor.marker) {
      throw new Error('environment adapter record escaped its local contract');
    }
    const parent = path.resolve(record.parentPath);
    const relative = path.relative(this.#sourceRoot, parent);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('environment adapter source record escaped the admitted root');
    return record;
  }

  async #source(source) {
    const value = requireObject(source, 'environment source');
    onlyKeys(value, new Set(['identity', 'revision', 'digest', 'handle']), 'environment source');
    if (typeof value.identity !== 'string' || !SAFE_ID.test(value.identity)) throw new TypeError('environment source identity is invalid');
    if (typeof value.revision !== 'string' || !SAFE_ID.test(value.revision)) throw new TypeError('environment source revision is invalid');
    const digest = String(value.digest ?? '').toLowerCase();
    if (!DIGEST.test(digest)) throw new TypeError('environment source digest is invalid');
    const handle = requireObject(value.handle, 'environment source handle');
    onlyKeys(handle, new Set(['location', 'format']), 'environment source handle');
    const location = handle.location;
    if (typeof location !== 'string' || location.length === 0 || location.includes('\0')) throw new TypeError('environment source location is invalid');
    const candidate = path.resolve(location);
    const info = await lstat(candidate, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment source must be a real regular file');
    const [root, actual] = await Promise.all([realpath(this.#sourceRoot), realpath(candidate)]);
    const relative = path.relative(root, actual);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('environment source is outside the admitted root');
    const format = String(handle.format ?? '').toLowerCase();
    if (!['vhd', 'vhdx'].includes(format)) throw new Error('environment source media is not supported by this adapter');
    return { identity: value.identity, revision: value.revision, digest, location: actual, format, fileIdentity: fileIdentity(info) };
  }

  async inspect() { return { identity: bindingIdentity(this.#identity) }; }

  async #storageObservation(record) {
    let parentInfo;
    let diskInfo;
    try {
      [parentInfo, diskInfo] = await Promise.all([lstat(record.parentPath, { bigint: true }), lstat(record.diskPath, { bigint: true })]);
    } catch (error) {
      if (error?.code === 'ENOENT') return { compatible: false, reason: 'environment storage lineage is incomplete' };
      throw error;
    }
    if (!parentInfo.isFile() || parentInfo.isSymbolicLink() || !diskInfo.isFile() || diskInfo.isSymbolicLink()) return { compatible: false, reason: 'environment storage lineage shape changed' };
    if (!sameFileIdentity(record.parentFileIdentity, fileIdentity(parentInfo))) return { compatible: false, reason: 'environment source filesystem identity changed' };
    if (record.diskFileIdentity && !sameFileIdentity(record.diskFileIdentity, fileIdentity(diskInfo))) return { compatible: false, reason: 'environment writable filesystem identity changed' };
    const observed = await this.#run(STORAGE_INSPECT_SCRIPT, record, 45_000);
    return observed?.compatible === true
      ? { compatible: true, reason: null }
      : { compatible: false, reason: String(observed?.reason ?? 'environment storage lineage is incompatible') };
  }

  async provision(raw) {
    const input = requireObject(raw, 'environment provision request');
    onlyKeys(input, new Set(['identity', 'source', 'settings']), 'environment provision request');
    const identity = input.identity;
    const descriptor = this.#descriptor(identity);
    const admitted = await this.#source(input.source);
    const settings = normalizeSettings(input.settings);
    const state = await this.#load();
    const diskPath = path.join(descriptor.local, `state.${admitted.format}`);
    const record = {
      identity,
      sourceIdentity: admitted.identity,
      sourceRevision: admitted.revision,
      sourceDigest: admitted.digest,
      parentPath: admitted.location,
      parentFileIdentity: admitted.fileIdentity,
      diskPath,
      diskFileIdentity: null,
      providerIdentity: null,
      diskFormat: admitted.format,
      name: descriptor.name,
      marker: descriptor.marker,
      configPath: descriptor.configPath,
      settings: structuredClone(settings),
    };
    const existing = this.#record(state, identity);
    if (existing) {
      const comparableExisting = { ...existing, diskFileIdentity: null, providerIdentity: null };
      if (JSON.stringify(comparableExisting) !== JSON.stringify(record)) throw new Error('environment adapter record conflicts with the requested lineage');
    }
    if (!existing) {
      state.records[identity] = record;
      await this.#save(state);
    }
    await mkdir(descriptor.local, { recursive: true, mode: 0o700 });
    const localInfo = await lstat(descriptor.local);
    if (!localInfo.isDirectory() || localInfo.isSymbolicLink()) throw new Error('environment object directory must be a real directory');
    const outcome = await this.#run(PROVISION_SCRIPT, {
      ...state.records[identity],
      memoryBytes: settings.memoryBytes,
      processorCount: settings.processorCount,
      firmware: settings.firmware,
      ...providerBootSettings(settings),
    }, 120_000);
    const providerIdentity = String(outcome?.providerIdentity ?? '').toLowerCase();
    if (!PROVIDER_ID.test(providerIdentity)) throw new Error('environment management did not return a valid provider identity');
    if (state.records[identity].providerIdentity && state.records[identity].providerIdentity !== providerIdentity) throw new Error('environment provider identity changed during provisioning');
    if (!state.records[identity].providerIdentity) {
      state.records[identity].providerIdentity = providerIdentity;
      await this.#save(state);
    }
    if (!state.records[identity].diskFileIdentity) {
      const diskInfo = await lstat(diskPath, { bigint: true });
      if (!diskInfo.isFile() || diskInfo.isSymbolicLink()) throw new Error('environment writable state shape changed');
      state.records[identity].diskFileIdentity = fileIdentity(diskInfo);
      await this.#save(state);
    }
    return this.observe(identity);
  }

  async observe(identity) {
    this.#descriptor(identity);
    const state = await this.#load();
    const record = this.#record(state, identity);
    if (!record) return { identity, exists: false, owned: false, compatible: false, state: 'absent', reason: 'environment adapter record is absent', storage: null };
    try {
      const [parentInfo, diskInfo] = await Promise.all([lstat(record.parentPath, { bigint: true }), lstat(record.diskPath, { bigint: true })]);
      if (!sameFileIdentity(record.parentFileIdentity, fileIdentity(parentInfo))) return { identity, exists: true, owned: true, compatible: false, state: 'unknown', reason: 'environment source filesystem identity changed', storage: null };
      if (record.diskFileIdentity && !sameFileIdentity(record.diskFileIdentity, fileIdentity(diskInfo))) return { identity, exists: true, owned: true, compatible: false, state: 'unknown', reason: 'environment writable filesystem identity changed', storage: null };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const raw = await this.#run(OBSERVE_SCRIPT, { ...record, ...providerBootSettings(normalizeSettings(record.settings)) }, 45_000);
    return normalizedObservation(identity, raw, record.sourceIdentity);
  }

  async start(identity) {
    const state = await this.#load();
    const record = this.#record(state, identity);
    if (!record) throw new Error('environment adapter record is absent');
    await this.#run(START_SCRIPT, record, 60_000);
    return this.observe(identity);
  }

  async stop(identity, { force = false, timeoutMs = 60_000 } = {}) {
    if (typeof force !== 'boolean') throw new TypeError('environment stop force must be boolean');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new TypeError('environment stop timeoutMs is invalid');
    const state = await this.#load();
    const record = this.#record(state, identity);
    if (!record) return { identity, exists: false, owned: false, compatible: false, state: 'absent', reason: 'environment adapter record is absent', storage: null };
    let observed = await this.observe(identity);
    if (!observed.exists) return observed;
    if (!observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment ownership evidence does not match');
    if (observed.state !== 'off') {
      await this.#run(STOP_SCRIPT, { ...record, force: false }, 30_000);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        observed = await this.observe(identity);
        if (!observed.exists || observed.state === 'off') break;
      }
      if (observed.exists && observed.state !== 'off') {
        if (!force) throw new Error('environment did not stop within the bounded wait');
        await this.#run(STOP_SCRIPT, { ...record, force: true }, 30_000);
        observed = await this.observe(identity);
        if (observed.exists && observed.state !== 'off') throw new Error('environment did not stop after forced termination');
      }
    }
    return observed;
  }

  async drop(identity) {
    const descriptor = this.#descriptor(identity);
    const state = await this.#load();
    const record = this.#record(state, identity);
    if (!record) return { identity, removed: false, absent: true };
    let diskInfo = null;
    try { diskInfo = await lstat(record.diskPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (diskInfo) {
      const storage = await this.#storageObservation(record);
      if (!storage.compatible) throw new Error(storage.reason ?? 'refusing to delete environment storage with mismatched lineage');
    }
    const observed = await this.observe(identity);
    if (observed.exists && (!observed.owned || !observed.compatible)) throw new Error(observed.reason ?? 'environment ownership evidence does not match');
    if (observed.exists && observed.state !== 'off') throw new Error('environment must be stopped before removal');
    const result = await this.#run(REMOVE_SCRIPT, record, 60_000);
    if (diskInfo) {
      if (!diskInfo.isFile() || diskInfo.isSymbolicLink()) throw new Error('environment writable state shape changed');
      const [root, actual] = await Promise.all([realpath(this.#directory), realpath(record.diskPath)]);
      const relative = path.relative(root, actual);
      if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('environment writable state escaped the owned root');
    }
    const localInfo = await lstat(descriptor.local).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (localInfo && (!localInfo.isDirectory() || localInfo.isSymbolicLink())) throw new Error('environment object directory shape changed');
    await rm(descriptor.local, { recursive: true, force: true });
    delete state.records[identity];
    await this.#save(state);
    return { identity, removed: result.removed === true || diskInfo != null, absent: result.absent === true && diskInfo == null };
  }
}
