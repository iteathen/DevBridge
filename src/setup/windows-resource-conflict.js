import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import { environmentNetworkDescriptor } from '../runtime/providers/hyperv-environment-identity.js';
import {
  clearSetupResourceConflict,
  normalizeSetupResourceConflictConsent,
  normalizeSetupResourceConflictObservation,
  setupResourceConflictRetirement,
  SETUP_RESOURCE_CONFLICT_OBSERVATION_PROTOCOL,
} from './resource-conflict.js';

const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);

const OBSERVATION_FUNCTIONS = String.raw`
function Get-Subject([string[]]$parts) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($parts -join [char]0))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Get-TranslationSubject($nat, $switch, [int]$mappingCount, [int]$sessionCount, [int]$adapterCount) {
  $domain = 'devbridge/setup-resource-conflict-subject-v1'
  $parts = @(
    $domain,
    [string]$nat.Name,
    [string]$nat.InternalIPInterfaceAddressPrefix,
    ([string]$switch.Id).ToLowerInvariant(),
    [string]$switch.SwitchType,
    [string]$switch.Notes,
    [string]$mappingCount,
    [string]$sessionCount,
    [string]$adapterCount
  )
  return Get-Subject $parts
}
function Get-SwitchSubject($switch, [int]$adapterCount, $addresses) {
  $addressEvidence = @($addresses | ForEach-Object {
    '{0}/{1}|{2}|{3}|{4}' -f [string]$_.IPAddress, [int]$_.PrefixLength, [string]$_.PrefixOrigin, [string]$_.SuffixOrigin, [string]$_.AddressState
  } | Sort-Object) -join [char]1
  $parts = @(
    'devbridge/setup-resource-conflict-switch-subject-v1',
    [string]$switch.Name,
    ([string]$switch.Id).ToLowerInvariant(),
    [string]$switch.SwitchType,
    [string]$switch.Notes,
    [string]$adapterCount,
    [string]$addressEvidence
  )
  return Get-Subject $parts
}
function Get-Conflict($data) {
  $translations = @(Get-NetNat -ErrorAction Stop)
  if ($translations.Count -eq 0) {
    $switches = @(Get-VMSwitch -ErrorAction Stop | Where-Object { [string]$_.Name -eq [string]$data.expected.name })
    if ($switches.Count -eq 0) { return [pscustomobject]@{ state = 'clear'; reason = $null; subject = $null; kind = $null; name = $null } }
    if ($switches.Count -ne 1) { return [pscustomobject]@{ state = 'blocked'; reason = 'local resource conflict is ambiguous'; subject = $null; kind = $null; name = $null } }
    $switch = $switches[0]
    if ([string]$switch.Notes -eq [string]$data.expected.marker -and [string]$switch.SwitchType -eq 'Internal') {
      return [pscustomobject]@{ state = 'clear'; reason = $null; subject = $null; kind = $null; name = $null }
    }
    if (-not [string]::IsNullOrEmpty([string]$switch.Notes) -or [string]$switch.SwitchType -ne 'Internal') {
      return [pscustomobject]@{ state = 'blocked'; reason = 'local resource conflicts with accepted ownership'; subject = $null; kind = $null; name = $null }
    }
    $adapterCount = @(Get-VMNetworkAdapter -VMName * -ErrorAction SilentlyContinue | Where-Object { $_.SwitchId -eq $switch.Id }).Count
    $alias = "vEthernet ($([string]$switch.Name))"
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $alias -ErrorAction Stop | Select-Object IPAddress,PrefixLength,PrefixOrigin,SuffixOrigin,AddressState)
    $configuredAddresses = @($addresses | Where-Object { [string]$_.IPAddress -notmatch '^169\.254\.' })
    if ($adapterCount -ne 0) {
      return [pscustomobject]@{ state = 'blocked'; reason = 'local resource conflict has active dependants'; subject = $null; kind = $null; name = $null }
    }
    if ($configuredAddresses.Count -ne 0) {
      return [pscustomobject]@{ state = 'blocked'; reason = 'local resource conflict has configured address state'; subject = $null; kind = $null; name = $null }
    }
    $subject = Get-SwitchSubject $switch $adapterCount $addresses
    return [pscustomobject]@{ state = 'approval-required'; reason = 'one inactive local resource blocks protected setup'; subject = $subject; kind = 'switch'; name = [string]$switch.Name }
  }
  if ($translations.Count -ne 1) { return [pscustomobject]@{ state = 'blocked'; reason = 'local resource conflict is ambiguous'; subject = $null; name = $null } }
  $nat = $translations[0]
  $switches = @(Get-VMSwitch -ErrorAction Stop | Where-Object { [string]$_.Name -eq [string]$nat.Name })
  if ([string]$nat.Name -eq [string]$data.expected.name) {
    if ([string]$nat.InternalIPInterfaceAddressPrefix -eq [string]$data.expected.prefix -and
        $switches.Count -eq 1 -and [string]$switches[0].Notes -eq [string]$data.expected.marker -and
        [string]$switches[0].SwitchType -eq 'Internal') {
      return [pscustomobject]@{ state = 'clear'; reason = $null; subject = $null; name = $null }
    }
    return [pscustomobject]@{ state = 'blocked'; reason = 'local resource conflicts with accepted ownership'; subject = $null; name = $null }
  }
  if ($switches.Count -ne 1 -or [string]$switches[0].SwitchType -ne 'Internal') {
    return [pscustomobject]@{ state = 'blocked'; reason = 'local resource conflict is not safely retireable'; subject = $null; name = $null }
  }
  $mappingCount = @(Get-NetNatStaticMapping -NatName ([string]$nat.Name) -ErrorAction SilentlyContinue).Count
  $sessionCount = @(Get-NetNatSession -ErrorAction SilentlyContinue | Where-Object { [string]$_.NatName -eq [string]$nat.Name }).Count
  $adapterCount = @(Get-VMNetworkAdapter -VMName * -ErrorAction SilentlyContinue | Where-Object { $_.SwitchId -eq $switches[0].Id }).Count
  if ($mappingCount -ne 0 -or $sessionCount -ne 0 -or $adapterCount -ne 0) {
    return [pscustomobject]@{ state = 'blocked'; reason = 'local resource conflict has active dependants'; subject = $null; name = $null }
  }
  $subject = Get-TranslationSubject $nat $switches[0] $mappingCount $sessionCount $adapterCount
  return [pscustomobject]@{ state = 'approval-required'; reason = 'one inactive local resource blocks protected setup'; subject = $subject; kind = 'translation'; name = [string]$nat.Name }
}
`;

const INSPECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
${OBSERVATION_FUNCTIONS}
$observed = Get-Conflict $data
@{ state = $observed.state; reason = $observed.reason; subject = $observed.subject } | ConvertTo-Json -Compress
`;

const RETIRE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
${OBSERVATION_FUNCTIONS}
$observed = Get-Conflict $data
if ($observed.state -eq 'clear') {
  @{ ready = $true; changed = $false; reason = $null } | ConvertTo-Json -Compress
  exit 0
}
if ($observed.state -ne 'approval-required') {
  @{ ready = $false; changed = $false; reason = [string]$observed.reason } | ConvertTo-Json -Compress
  exit 0
}
if ([string]$observed.subject -ne [string]$data.subject) {
  @{ ready = $false; changed = $false; reason = 'approved local resource subject changed before retirement' } | ConvertTo-Json -Compress
  exit 0
}
if ([string]$observed.kind -eq 'translation') {
  Remove-NetNat -Name ([string]$observed.name) -Confirm:$false -ErrorAction Stop
  if (@(Get-NetNat -Name ([string]$observed.name) -ErrorAction SilentlyContinue).Count -ne 0) { throw 'retired local resource remains present' }
} elseif ([string]$observed.kind -eq 'switch') {
  Remove-VMSwitch -Name ([string]$observed.name) -Force -Confirm:$false -ErrorAction Stop
  if (@(Get-VMSwitch -ErrorAction Stop | Where-Object { [string]$_.Name -eq [string]$observed.name }).Count -ne 0) { throw 'retired local resource remains present' }
} else {
  throw 'approved local resource kind is invalid'
}
@{ ready = $true; changed = $true; reason = $null } | ConvertTo-Json -Compress
`;

function encodedScript(value) {
  return Buffer.from(value, 'utf16le').toString('base64');
}

function invocationSucceeded(result) {
  return result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true && result?.outputTruncated !== true;
}

async function run(invoke, script, payload) {
  const result = await invoke({
    executable: POWERSHELL,
    arguments: [...POWERSHELL_ARGS, encodedScript(script)],
    input: JSON.stringify(payload),
    timeoutMs: 45_000,
    maxOutputBytes: 64 * 1024,
  });
  if (!invocationSucceeded(result)) throw new Error('local resource conflict operation failed');
  try { return JSON.parse(String(result.stdout ?? '').trim()); }
  catch { throw new Error('local resource conflict operation returned invalid evidence'); }
}

export function createWindowsSetupResourceConflict({
  identity,
  platform = process.platform,
  invoke = invokeCommand,
} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('setup resource conflict invocation contract is invalid');
  const expected = environmentNetworkDescriptor(identity);
  return Object.freeze({
    async inspect() {
      if (platform !== 'win32') return clearSetupResourceConflict();
      const raw = await run(invoke, INSPECT_SCRIPT, { expected });
      return normalizeSetupResourceConflictObservation({
        protocol: SETUP_RESOURCE_CONFLICT_OBSERVATION_PROTOCOL,
        state: raw?.state,
        subject: raw?.subject ?? null,
        reason: raw?.reason ?? null,
      });
    },

    async retire(rawConsent) {
      const consent = normalizeSetupResourceConflictConsent(rawConsent);
      if (platform !== 'win32') return setupResourceConflictRetirement({ ready: true, changed: false });
      const raw = await run(invoke, RETIRE_SCRIPT, { expected, subject: consent.subject });
      return setupResourceConflictRetirement({ ready: raw?.ready, changed: raw?.changed, reason: raw?.reason ?? null });
    },
  });
}
