[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$Root,

    [Parameter(Mandatory = $true)]
    [string]$InstallerIso,

    [Parameter(Mandatory = $true)]
    [string]$SeedIso,

    [string]$SwitchName = 'Default Switch',
    [ValidateRange(1, 64)]
    [int]$ProcessorCount = 4,
    [ValidateRange(2147483648, 68719476736)]
    [long]$MemoryBytes = 4GB,
    [ValidateRange(21474836480, 1099511627776)]
    [long]$DiskBytes = 50GB
)

$ErrorActionPreference = 'Stop'
Import-Module Hyper-V -ErrorAction Stop

$rootPath = [System.IO.Path]::GetFullPath($Root)
$installerPath = (Resolve-Path -LiteralPath $InstallerIso).Path
$seedPath = (Resolve-Path -LiteralPath $SeedIso).Path
$diskPath = Join-Path $rootPath "$Name.vhdx"

foreach ($media in @($installerPath, $seedPath)) {
    $item = Get-Item -LiteralPath $media
    if (-not $item.PSIsContainer -and $item.Extension -eq '.iso') { continue }
    throw "Installer media must be an ISO file: $media"
}
if (Get-VM -Name $Name -ErrorAction SilentlyContinue) { throw "VM already exists: $Name" }
if (Test-Path -LiteralPath $rootPath) { throw "Builder root already exists: $rootPath" }
if (-not (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)) { throw "Hyper-V switch is unavailable: $SwitchName" }

[System.IO.Directory]::CreateDirectory($rootPath) | Out-Null
$vm = New-VM -Name $Name -Generation 2 -MemoryStartupBytes $MemoryBytes -NewVHDPath $diskPath -NewVHDSizeBytes $DiskBytes -SwitchName $SwitchName -Path $rootPath
Set-VM -Name $Name -ProcessorCount $ProcessorCount -AutomaticCheckpointsEnabled $false -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -Notes 'Owned by DevBridge disposable fast-track Ubuntu base-image build; do not adopt as a production environment.'
Set-VMMemory -VMName $Name -DynamicMemoryEnabled $false
Set-VMFirmware -VMName $Name -EnableSecureBoot Off
Enable-VMIntegrationService -VMName $Name -Name 'Guest Service Interface'
$installer = Add-VMDvdDrive -VMName $Name -Path $installerPath -Passthru
Add-VMDvdDrive -VMName $Name -Path $seedPath | Out-Null
Set-VMFirmware -VMName $Name -FirstBootDevice $installer
Start-VM -Name $Name | Out-Null

$observed = Get-VM -Name $Name
[pscustomobject]@{
    Name = $observed.Name
    State = $observed.State.ToString()
    Root = $rootPath
    Disk = $diskPath
    Installer = $installerPath
    Seed = $seedPath
    Switch = $SwitchName
    ProcessorCount = $observed.ProcessorCount
    MemoryBytes = $observed.MemoryStartup
} | ConvertTo-Json -Compress
