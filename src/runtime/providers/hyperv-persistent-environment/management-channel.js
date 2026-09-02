const POWERSHELL = 'powershell.exe';
const COMMAND_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

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
if (-not (Test-Path -LiteralPath $data.diskPath -PathType Leaf)) {
  $null = New-VHD -Path $data.diskPath -ParentPath $data.parentPath -Differencing -ErrorAction Stop
}
if (-not (Test-VHD -Path $data.diskPath -ErrorAction Stop)) { throw 'environment writable state is unusable' }
$disk = Get-VHD -Path $data.diskPath -ErrorAction Stop
$actualParent = if ([string]::IsNullOrWhiteSpace([string]$disk.ParentPath)) { $null } else { [IO.Path]::GetFullPath([string]$disk.ParentPath) }
if ([string]$disk.VhdType -ne 'Differencing' -or $actualParent -ne [IO.Path]::GetFullPath([string]$data.parentPath)) { throw 'environment writable lineage does not match' }
$vmGeneration = if ([string]$data.firmware -eq 'bios') { 1 } else { 2 }
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
$created = $false
if ($null -eq $item) {
  $null = New-Item -ItemType Directory -Path $data.creationConfigPath -Force -ErrorAction Stop
  $item = New-VM -Name $data.name -MemoryStartupBytes ([long]$data.memoryBytes) -Generation $vmGeneration -VHDPath $data.diskPath -Path $data.creationConfigPath -ErrorAction Stop
  $created = $true
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
@{ ready = $true; providerIdentity = $actualIdentity; created = $created } | ConvertTo-Json -Compress
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

export class HyperVEnvironmentChannel {
  #invoke;

  constructor({ invoke }) {
    if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
    this.#invoke = invoke;
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

  inspectStorage(record) { return this.#run(STORAGE_INSPECT_SCRIPT, record, 45_000); }
  provision(payload) { return this.#run(PROVISION_SCRIPT, payload, 120_000); }
  async observe(identity, payload, sourceIdentity = null) {
    return normalizedObservation(identity, await this.#run(OBSERVE_SCRIPT, payload, 45_000), sourceIdentity);
  }
  start(record) { return this.#run(START_SCRIPT, record, 60_000); }
  stop(record, force) { return this.#run(STOP_SCRIPT, { ...record, force }, 30_000); }
  remove(record) { return this.#run(REMOVE_SCRIPT, record, 60_000); }
}

