[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$StateDirectory,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^env-[a-f0-9]{32}$')]
    [string]$Target,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Status', 'Show', 'Save', 'Resume')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module Hyper-V -ErrorAction Stop

$stateRoot = [System.IO.Path]::GetFullPath($StateDirectory)
$stateFile = Join-Path $stateRoot 'environment-foundation\persistent\operations\state.json'
$stateItem = Get-Item -LiteralPath $stateFile -ErrorAction Stop
if ($stateItem.PSIsContainer -or $stateItem.Length -gt 4MB) { throw 'Fast VM provider state is invalid.' }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
if ([string]$state.protocol -ne 'devbridge/hyperv-persistent-environment-v1') { throw 'Fast VM provider state protocol is invalid.' }
$record = $state.records.PSObject.Properties[$Target].Value
if ($null -eq $record) { throw 'Fast VM target is not registered.' }

$vm = Get-VM -Name ([string]$record.name) -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -ne ([string]$record.providerIdentity).ToLowerInvariant()) { throw 'Fast VM provider identity does not match.' }
if ([string]$vm.Notes -ne [string]$record.marker) { throw 'Fast VM ownership evidence does not match.' }

switch ($Action) {
    'Show' {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\vmconnect.exe') -ArgumentList @('localhost', [string]$vm.Name)
    }
    'Save' {
        if ([string]$vm.State -eq 'Running') {
            Save-VM -VM $vm -ErrorAction Stop
        } elseif ([string]$vm.State -ne 'Saved') {
            throw "Fast VM cannot be saved from state $($vm.State)."
        }
    }
    'Resume' {
        if ([string]$vm.State -eq 'Paused') {
            Resume-VM -VM $vm -ErrorAction Stop
        } elseif ([string]$vm.State -eq 'Saved' -or [string]$vm.State -eq 'Off') {
            Start-VM -VM $vm -ErrorAction Stop
        } elseif ([string]$vm.State -ne 'Running') {
            throw "Fast VM cannot resume from state $($vm.State)."
        }
    }
}

$observed = Get-VM -Name ([string]$record.name) -ErrorAction Stop
[pscustomobject]@{
    Target = $Target
    Name = [string]$observed.Name
    State = [string]$observed.State
    Action = $Action
} | ConvertTo-Json -Compress
