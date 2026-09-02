const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

function encodeScript(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

function parseJson(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    const detail = String(result?.stderr || result?.stdout || 'construction management operation failed').trim().slice(0, 2048);
    throw new Error(detail || 'construction management operation failed');
  }
  try { return JSON.parse(String(result.stdout ?? '')); } catch { throw new Error('construction management operation returned invalid structured output'); }
}

const PREPARE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
if (-not (Test-Path -LiteralPath $data.installerPath -PathType Leaf)) { throw 'installer media is absent' }
if (-not (Test-Path -LiteralPath $data.seedPath -PathType Leaf)) { throw 'seed media is absent' }
$switch = if ([string]$data.networkControl -eq 'owned') {
  Get-VMSwitch -Name ([string]$data.networkReference) -ErrorAction Stop
} elseif ([string]$data.networkControl -eq 'system') {
  Get-VMSwitch -Id ([guid]$data.networkReference) -ErrorAction Stop
} else { throw 'construction network control is invalid' }
if ([string]$data.networkControl -eq 'owned' -and [string]$switch.Notes -ne [string]$data.networkProof) { throw 'construction network ownership proof does not match' }
if ([string]$data.networkControl -eq 'system' -and ([string]$data.networkProof).ToLowerInvariant() -ne ([string]$switch.Id).ToLowerInvariant()) { throw 'construction system-network proof does not match' }
if ([string]$switch.SwitchType -ne 'Internal') { throw 'construction network type is incompatible' }
$null = New-Item -ItemType Directory -Path ([string]$data.configPath) -Force -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -eq $item) {
  $item = New-VM -Name ([string]$data.name) -Generation 2 -NoVHD -MemoryStartupBytes ([long]$data.memoryBytes) -Path ([string]$data.configPath) -SwitchName ([string]$switch.Name) -ErrorAction Stop
}
if ([string]$item.State -ne 'Off') { throw 'construction machine must be stopped during preparation' }
$alreadyOwned = [string]$item.Notes -eq [string]$data.marker
if (-not $alreadyOwned) {
  $hard = @(Get-VMHardDiskDrive -VMName ([string]$data.name) -ErrorAction Stop)
  $dvd = @(Get-VMDvdDrive -VMName ([string]$data.name) -ErrorAction Stop)
  $net = @(Get-VMNetworkAdapter -VMName ([string]$data.name) -ErrorAction Stop)
  $expectedConfig = [IO.Path]::GetFullPath((Join-Path ([string]$data.configPath) ([string]$data.name)))
  $actualConfig = [IO.Path]::GetFullPath([string]$item.ConfigurationLocation)
  $configMatches = [StringComparer]::OrdinalIgnoreCase.Equals($actualConfig, $expectedConfig)
  $defaultAdapterMatches = $net.Count -eq 1 -and [string]$net[0].Name -eq 'Network Adapter' -and $net[0].IsLegacy -eq $false -and $net[0].DynamicMacAddressEnabled -eq $true
  $adapterIsUnbound = $defaultAdapterMatches -and $net[0].Connected -eq $false -and [string]::IsNullOrWhiteSpace([string]$net[0].SwitchName) -and [string]::IsNullOrWhiteSpace([string]$net[0].SwitchId)
  $adapterIsExpected = $defaultAdapterMatches -and -not [string]::IsNullOrWhiteSpace([string]$net[0].SwitchId) -and ([string]$net[0].SwitchId).ToLowerInvariant() -eq ([string]$switch.Id).ToLowerInvariant()
  if (-not [string]::IsNullOrWhiteSpace([string]$item.Notes) -or [int]$item.Generation -ne 2 -or [long]$item.MemoryStartup -ne [long]$data.memoryBytes -or -not $configMatches -or $hard.Count -ne 0 -or $dvd.Count -ne 0 -or (-not $adapterIsUnbound -and -not $adapterIsExpected)) {
    throw 'construction machine name is occupied without matching ownership evidence'
  }
}
Set-VM -Name ([string]$data.name) -AutomaticCheckpointsEnabled $false -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -MemoryStartupBytes ([long]$data.memoryBytes) -ErrorAction Stop
Set-VMProcessor -VMName ([string]$data.name) -Count ([long]$data.processorCount) -ErrorAction Stop
$security = Get-VMSecurity -VMName ([string]$data.name) -ErrorAction Stop
if ($alreadyOwned) {
  if ([bool]$security.TpmEnabled -ne [bool]$data.identityRequired) { throw 'construction protected identity does not match' }
  $firmware = Get-VMFirmware -VMName ([string]$data.name) -ErrorAction Stop
  $integrityMatches = ([string]$firmware.SecureBoot -eq 'On') -eq [bool]$data.integrityRequired
  if ($data.integrityRequired -eq $true) { $integrityMatches = $integrityMatches -and [string]$firmware.SecureBootTemplate -eq [string]$data.trustTemplate }
  if (-not $integrityMatches) { throw 'construction firmware integrity does not match' }
} else {
  if ($data.integrityRequired -eq $true) { Set-VMFirmware -VMName ([string]$data.name) -EnableSecureBoot On -SecureBootTemplate ([string]$data.trustTemplate) -ErrorAction Stop }
  else { Set-VMFirmware -VMName ([string]$data.name) -EnableSecureBoot Off -ErrorAction Stop }
  if ($data.identityRequired -eq $true -and -not [bool]$security.TpmEnabled) {
    Set-VMKeyProtector -VMName ([string]$data.name) -NewLocalKeyProtector -ErrorAction Stop
    Enable-VMTPM -VMName ([string]$data.name) -ErrorAction Stop
  } elseif ($data.identityRequired -ne $true -and [bool]$security.TpmEnabled) {
    throw 'construction protected identity does not match'
  }
  Set-VM -Name ([string]$data.name) -Notes ([string]$data.marker) -ErrorAction Stop
}
$nets = @(Get-VMNetworkAdapter -VMName ([string]$data.name) -ErrorAction Stop)
if ($nets.Count -eq 0) {
  Add-VMNetworkAdapter -VMName ([string]$data.name) -Name 'Network Adapter' -SwitchName ([string]$switch.Name) -ErrorAction Stop | Out-Null
  $nets = @(Get-VMNetworkAdapter -VMName ([string]$data.name) -ErrorAction Stop)
}
if ($nets.Count -ne 1) { throw 'construction network adapter count is incompatible' }
$networkMatches = if ([string]$data.networkControl -eq 'owned') { [string]$nets[0].SwitchName -eq [string]$data.networkReference } else { ([string]$nets[0].SwitchId).ToLowerInvariant() -eq ([string]$data.networkReference).ToLowerInvariant() }
if (-not $networkMatches) { Connect-VMNetworkAdapter -VMNetworkAdapter $nets[0] -VMSwitch $switch -ErrorAction Stop }
if (-not (Test-Path -LiteralPath $data.diskPath -PathType Leaf)) {
  $null = New-VHD -Path ([string]$data.diskPath) -Dynamic -SizeBytes ([long]$data.diskBytes) -ErrorAction Stop
}
if (-not (Test-VHD -Path ([string]$data.diskPath) -ErrorAction Stop)) { throw 'construction disk is unusable' }
$disk = Get-VHD -Path ([string]$data.diskPath) -ErrorAction Stop
if ([string]$disk.VhdType -ne 'Dynamic' -or -not [string]::IsNullOrWhiteSpace([string]$disk.ParentPath) -or [long]$disk.Size -ne [long]$data.diskBytes) { throw 'construction disk shape does not match' }
$hard = @(Get-VMHardDiskDrive -VMName ([string]$data.name) -ErrorAction Stop)
if ($hard.Count -eq 0) {
  Add-VMHardDiskDrive -VMName ([string]$data.name) -ControllerType SCSI -ControllerNumber 0 -ControllerLocation 0 -Path ([string]$data.diskPath) -ErrorAction Stop
  $hard = @(Get-VMHardDiskDrive -VMName ([string]$data.name) -ErrorAction Stop)
}
if ($hard.Count -ne 1 -or [IO.Path]::GetFullPath([string]$hard[0].Path) -ne [IO.Path]::GetFullPath([string]$data.diskPath)) { throw 'construction disk attachment does not match' }
$dvd = @(Get-VMDvdDrive -VMName ([string]$data.name) -ErrorAction Stop)
$installer = $dvd | Where-Object { $_.ControllerNumber -eq 0 -and $_.ControllerLocation -eq 1 } | Select-Object -First 1
if ($null -eq $installer) { Add-VMDvdDrive -VMName ([string]$data.name) -ControllerNumber 0 -ControllerLocation 1 -Path ([string]$data.installerPath) -ErrorAction Stop; $installer = Get-VMDvdDrive -VMName ([string]$data.name) -ControllerNumber 0 -ControllerLocation 1 -ErrorAction Stop }
elseif ([IO.Path]::GetFullPath([string]$installer.Path) -ne [IO.Path]::GetFullPath([string]$data.installerPath)) { throw 'installer media attachment does not match' }
$seed = $dvd | Where-Object { $_.ControllerNumber -eq 0 -and $_.ControllerLocation -eq 2 } | Select-Object -First 1
if ($null -eq $seed) { Add-VMDvdDrive -VMName ([string]$data.name) -ControllerNumber 0 -ControllerLocation 2 -Path ([string]$data.seedPath) -ErrorAction Stop; $seed = Get-VMDvdDrive -VMName ([string]$data.name) -ControllerNumber 0 -ControllerLocation 2 -ErrorAction Stop }
elseif ([IO.Path]::GetFullPath([string]$seed.Path) -ne [IO.Path]::GetFullPath([string]$data.seedPath)) { throw 'seed media attachment does not match' }
$dvd = @(Get-VMDvdDrive -VMName ([string]$data.name) -ErrorAction Stop)
if ($dvd.Count -ne 2) { throw 'construction media attachment count is incompatible' }
Set-VMFirmware -VMName ([string]$data.name) -FirstBootDevice $installer -ErrorAction Stop
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
@{ ready = $true; providerIdentity = ([string]$item.Id).ToLowerInvariant() } | ConvertTo-Json -Compress
`;

const OBSERVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -eq $item) {
  @{ exists = $false; owned = $false; compatible = $false; reason = 'construction machine is absent'; state = 'absent'; diskPresent = (Test-Path -LiteralPath $data.diskPath -PathType Leaf); diskAttached = $false; mediaCount = 0; uptimeMilliseconds = 0; cpuUsagePercent = 0; providerStatus = 'absent'; diskAllocatedBytes = 0 } | ConvertTo-Json -Compress
  exit 0
}
$owned = [string]$item.Notes -eq [string]$data.marker
$compatible = $owned
$reason = if ($owned) { $null } else { 'construction ownership evidence does not match' }
if ($owned -and [int]$item.Generation -ne 2) { $compatible = $false; $reason = 'construction firmware generation does not match' }
if ($owned -and $compatible) {
  $security = Get-VMSecurity -VMName ([string]$data.name) -ErrorAction Stop
  if ([bool]$security.TpmEnabled -ne [bool]$data.identityRequired) { $compatible = $false; $reason = 'construction protected identity does not match' }
}
if ($owned -and $compatible) {
  $firmware = Get-VMFirmware -VMName ([string]$data.name) -ErrorAction Stop
  $integrityMatches = ([string]$firmware.SecureBoot -eq 'On') -eq [bool]$data.integrityRequired
  if ($data.integrityRequired -eq $true) { $integrityMatches = $integrityMatches -and [string]$firmware.SecureBootTemplate -eq [string]$data.trustTemplate }
  if (-not $integrityMatches) { $compatible = $false; $reason = 'construction firmware integrity does not match' }
}
$hard = @(Get-VMHardDiskDrive -VMName ([string]$data.name) -ErrorAction Stop)
$diskAttached = $hard.Count -eq 1 -and [IO.Path]::GetFullPath([string]$hard[0].Path) -eq [IO.Path]::GetFullPath([string]$data.diskPath)
$mediaCount = @(Get-VMDvdDrive -VMName ([string]$data.name) -ErrorAction Stop).Count
$diskPresent = Test-Path -LiteralPath $data.diskPath -PathType Leaf
$diskAllocatedBytes = 0
if ($diskPresent) {
  $disk = Get-VHD -Path ([string]$data.diskPath) -ErrorAction Stop
  $diskAllocatedBytes = [long]$disk.FileSize
}
@{ exists = $true; owned = $owned; compatible = $compatible; reason = $reason; state = ([string]$item.State).ToLowerInvariant(); providerIdentity = ([string]$item.Id).ToLowerInvariant(); diskPresent = $diskPresent; diskAttached = $diskAttached; mediaCount = [int]$mediaCount; uptimeMilliseconds = [long][Math]::Floor($item.Uptime.TotalMilliseconds); cpuUsagePercent = [int]$item.CPUUsage; providerStatus = [string]$item.Status; diskAllocatedBytes = $diskAllocatedBytes } | ConvertTo-Json -Compress
`;

const INSTALL_CONSOLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$vm = Get-CimInstance -Namespace 'root/virtualization/v2' -ClassName Msvm_ComputerSystem -ErrorAction Stop |
  Where-Object { ([string]$_.Name).Trim('{}').ToLowerInvariant() -eq ([string]$data.providerIdentity).Trim('{}').ToLowerInvariant() } |
  Select-Object -First 1
if ($null -eq $vm) { throw 'construction console provider identity is absent' }
if ([string]$vm.ElementName -ne [string]$data.name) { throw 'construction console provider name changed' }
$settings = Get-CimAssociatedInstance -InputObject $vm -Association Msvm_SettingsDefineState -ResultClassName Msvm_VirtualSystemSettingData -ErrorAction Stop |
  Where-Object { [string]$_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' } |
  Select-Object -First 1
if ($null -eq $settings) { throw 'construction console realized settings are absent' }
$service = Get-CimInstance -Namespace 'root/virtualization/v2' -ClassName Msvm_VirtualSystemManagementService -ErrorAction Stop | Select-Object -First 1
if ($null -eq $service) { throw 'construction console management service is absent' }
$result = Invoke-CimMethod -InputObject $service -MethodName GetVirtualSystemThumbnailImage -Arguments @{
  TargetSystem = $settings
  WidthPixels = [uint16]320
  HeightPixels = [uint16]240
} -ErrorAction Stop
if ([uint32]$result.ReturnValue -ne 0) {
  @{ available = $false; reason = "Hyper-V thumbnail returned $([uint32]$result.ReturnValue)" } | ConvertTo-Json -Compress
  exit 0
}
$bytes = [byte[]]$result.ImageData
@{ available = $true; width = 320; height = 240; imageData = [Convert]::ToBase64String($bytes) } | ConvertTo-Json -Compress
`;

const START_INSTALL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
if (([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
if ([string]$item.State -eq 'Off') { Start-VM -Name ([string]$data.name) -ErrorAction Stop | Out-Null }
elseif ([string]$item.State -ne 'Running') { throw 'construction machine is not startable' }
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
@{ started = $true; state = ([string]$item.State).ToLowerInvariant() } | ConvertTo-Json -Compress
`;

const GUEST_ADDRESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
if (([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
if ([string]$item.State -ne 'Running') { @{ ready = $false; reason = 'construction machine is not running'; addresses = @() } | ConvertTo-Json -Compress; exit 0 }
$adapters = @(Get-VMNetworkAdapter -VMName ([string]$data.name) -ErrorAction Stop)
if ($adapters.Count -ne 1) { throw 'construction network adapter count is incompatible' }
$matches = if ([string]$data.networkControl -eq 'owned') { [string]$adapters[0].SwitchName -eq [string]$data.networkReference } else { ([string]$adapters[0].SwitchId).ToLowerInvariant() -eq ([string]$data.networkReference).ToLowerInvariant() }
if (-not $matches) { throw 'construction network binding changed' }
@{ ready = $true; reason = $null; addresses = @($adapters[0].IPAddresses) } | ConvertTo-Json -Compress
`;

const BOOT_INSTALLED_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
if (([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
if ([string]$item.State -ne 'Off') { throw 'installer must finish and power off before installed boot' }
$hard = @(Get-VMHardDiskDrive -VMName ([string]$data.name) -ErrorAction Stop)
if ($hard.Count -ne 1 -or [IO.Path]::GetFullPath([string]$hard[0].Path) -ne [IO.Path]::GetFullPath([string]$data.diskPath)) { throw 'construction disk attachment does not match' }
Get-VMDvdDrive -VMName ([string]$data.name) -ErrorAction Stop | Remove-VMDvdDrive -ErrorAction Stop
Set-VMFirmware -VMName ([string]$data.name) -FirstBootDevice $hard[0] -ErrorAction Stop
Start-VM -Name ([string]$data.name) -ErrorAction Stop | Out-Null
@{ started = $true } | ConvertTo-Json -Compress
`;

const STOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -eq $item) { @{ stopped = $false; absent = $true } | ConvertTo-Json -Compress; exit 0 }
if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
if (([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
if ([string]$item.State -ne 'Off') {
  if ($data.force -eq $true) { Stop-VM -Name ([string]$data.name) -TurnOff -Confirm:$false -ErrorAction Stop }
  else { Stop-VM -Name ([string]$data.name) -Confirm:$false -ErrorAction Stop }
}
@{ stopped = $true; absent = $false } | ConvertTo-Json -Compress
`;

const RETAIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -ne $item) {
  if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
  if (([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
  if ([string]$item.State -ne 'Off') { throw 'construction machine must be stopped before image retention' }
}
if (-not (Test-VHD -Path ([string]$data.diskPath) -ErrorAction Stop)) { throw 'construction disk is unusable' }
$disk = Get-VHD -Path ([string]$data.diskPath) -ErrorAction Stop
if ([string]$disk.VhdType -ne 'Dynamic' -or -not [string]::IsNullOrWhiteSpace([string]$disk.ParentPath)) { throw 'construction disk is not a standalone image' }
if ($null -ne $item) { Remove-VM -Name ([string]$data.name) -Force -ErrorAction Stop }
$disk = Get-VHD -Path ([string]$data.diskPath) -ErrorAction Stop
@{ retained = $true; virtualBytes = [long]$disk.Size; allocatedBytes = [long]$disk.FileSize; diskIdentity = [string]$disk.DiskIdentifier } | ConvertTo-Json -Compress
`;

const RETIRE_PROVIDER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -ne $item) {
  if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
  if (-not [string]::IsNullOrWhiteSpace([string]$data.providerIdentity) -and ([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
  if ([string]$item.State -ne 'Off') { throw 'construction machine must be stopped before retirement' }
  Remove-VM -Name ([string]$data.name) -Force -ErrorAction Stop
}
$remaining = @(Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name })
if ($remaining.Count -ne 0) { throw 'construction machine remains after retirement' }
@{ retired = $true; absent = ($null -eq $item) } | ConvertTo-Json -Compress
`;

const OBSERVE_DISK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -ne $item) {
  if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
  if (-not [string]::IsNullOrWhiteSpace([string]$data.providerIdentity) -and ([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
}
if (-not (Test-Path -LiteralPath ([string]$data.diskPath) -PathType Leaf)) {
  @{ exists = $false; attached = $false; compatible = $true; allocatedBytes = 0; virtualBytes = 0; diskIdentity = $null } | ConvertTo-Json -Compress
  exit 0
}
$attachments = @(
  Get-VM -ErrorAction Stop | ForEach-Object { Get-VMHardDiskDrive -VM $_ -ErrorAction Stop } |
    Where-Object { [IO.Path]::GetFullPath([string]$_.Path) -eq [IO.Path]::GetFullPath([string]$data.diskPath) }
)
$disk = Get-VHD -Path ([string]$data.diskPath) -ErrorAction Stop
$compatible = [string]$disk.VhdType -eq 'Dynamic' -and [string]::IsNullOrWhiteSpace([string]$disk.ParentPath)
@{
  exists = $true
  attached = $attachments.Count -ne 0
  compatible = $compatible
  allocatedBytes = [long]$disk.FileSize
  virtualBytes = [long]$disk.Size
  diskIdentity = [string]$disk.DiskIdentifier
} | ConvertTo-Json -Compress
`;

export class HyperVConstructionChannel {
  #invoke;

  constructor({ invoke }) {
    if (typeof invoke !== 'function') throw new TypeError('construction invoke must be a function');
    this.#invoke = invoke;
  }

  async #run(script, payload, timeoutMs = 90_000) {
    return parseJson(await this.#invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodeScript(script)],
      input: JSON.stringify(payload),
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
    }));
  }

  prepare(payload) { return this.#run(PREPARE_SCRIPT, payload, 120_000); }
  observe(payload) { return this.#run(OBSERVE_SCRIPT, payload, 30_000); }
  console(payload) { return this.#run(INSTALL_CONSOLE_SCRIPT, payload, 30_000); }
  startInstall(payload) { return this.#run(START_INSTALL_SCRIPT, payload, 60_000); }
  address(payload) { return this.#run(GUEST_ADDRESS_SCRIPT, payload, 30_000); }
  bootInstalled(payload) { return this.#run(BOOT_INSTALLED_SCRIPT, payload, 60_000); }
  stop(payload) { return this.#run(STOP_SCRIPT, payload, 120_000); }
  retain(payload) { return this.#run(RETAIN_SCRIPT, payload, 60_000); }
  retireProvider(payload) { return this.#run(RETIRE_PROVIDER_SCRIPT, payload, 60_000); }
  observeDisk(payload) { return this.#run(OBSERVE_DISK_SCRIPT, payload, 60_000); }
}
