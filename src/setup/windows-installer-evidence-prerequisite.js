import path from 'node:path';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';
import { hyperVInstallerEvidenceService } from '../runtime/providers/hyperv-installer-evidence.js';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (@('inspect', 'establish') -cnotcontains [string]$data.action) { throw 'installer evidence prerequisite action is invalid' }
$parent = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices'
$location = $parent + '\' + [string]$data.serviceId
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Read-State {
  if (-not (Test-Path -LiteralPath $location)) { return 'absent' }
  $key = Get-Item -LiteralPath $location -ErrorAction Stop
  try {
    if ([string]$key.GetValue('DevBridgeOwner') -cne [string]$data.owner -or [string]$key.GetValue('ElementName') -cne [string]$data.elementName) { return 'foreign' }
    if ($key.GetValueKind('DevBridgeOwner') -ne [Microsoft.Win32.RegistryValueKind]::String -or $key.GetValueKind('ElementName') -ne [Microsoft.Win32.RegistryValueKind]::String) { return 'foreign' }
    return 'ready'
  } finally { $key.Dispose() }
}
$state = Read-State
if ([string]$data.action -ceq 'inspect') {
  @{ state = $state; elevated = [bool]$elevated; changed = $false } | ConvertTo-Json -Compress
  exit 0
}
if ($state -cne 'absent') { throw 'installer evidence registration changed before establishment' }
if (-not $elevated) { throw 'installer evidence registration requires an administrator token' }
# No Force: an existing or concurrently created key must never be replaced.
# A crash before complete ownership is published leaves a blocked key, not an
# implicitly adoptable registration. Re-entry observes before any new attempt.
$created = New-Item -Path $parent -Name ([string]$data.serviceId) -ErrorAction Stop
try {
  $created.SetValue('DevBridgeOwner', [string]$data.owner, [Microsoft.Win32.RegistryValueKind]::String)
  $created.SetValue('ElementName', [string]$data.elementName, [Microsoft.Win32.RegistryValueKind]::String)
  $created.Flush()
} finally { $created.Dispose() }
@{ state = (Read-State); elevated = [bool]$elevated; changed = $true } | ConvertTo-Json -Compress
`;

async function invokeRegistration({ identity, invoke, environment, action }) {
  if (typeof invoke !== 'function' || !['inspect', 'establish'].includes(action)) throw new TypeError('installer evidence prerequisite ports are invalid');
  const service = hyperVInstallerEvidenceService(identity);
  const result = await invoke({
    executable: 'powershell.exe',
    arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    input: JSON.stringify({ ...service, action }), environment,
    timeoutMs: 30_000, maxOutputBytes: 16 * 1024,
  });
  if (result?.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) throw new Error('installer evidence registration observation or establishment failed');
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('installer evidence registration response is invalid'); }
  if (!value || Object.keys(value).length !== 3 || !['absent', 'foreign', 'ready'].includes(value.state)
      || typeof value.elevated !== 'boolean' || typeof value.changed !== 'boolean'
      || (action === 'inspect' && value.changed)) throw new Error('installer evidence registration response is invalid');
  return Object.freeze(value);
}

export async function inspectWindowsInstallerEvidenceRegistration({ identity, invoke, environment } = {}) {
  return invokeRegistration({ identity, invoke, environment, action: 'inspect' });
}

export async function reconcileWindowsInstallerEvidencePrerequisite({ stateDirectory, invoke, environment } = {}, {
  identitySource = loadOrCreateLocalIdentity,
} = {}) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory) || stateDirectory.includes('\0')
      || typeof identitySource !== 'function' || typeof invoke !== 'function') throw new TypeError('installer evidence prerequisite configuration is invalid');
  const identity = await identitySource({ directory: path.join(stateDirectory, 'environment-foundation') });
  const request = { identity, invoke, environment };
  const observed = await inspectWindowsInstallerEvidenceRegistration(request);
  if (observed.state === 'ready') return Object.freeze({ ready: true, changed: false, blocker: null });
  if (observed.state === 'foreign') return Object.freeze({ ready: false, changed: false, blocker: 'The installer diagnostic registration has conflicting or incomplete ownership; it cannot be adopted or replaced automatically.' });
  if (!observed.elevated) return Object.freeze({ ready: false, changed: false, blocker: 'The installer diagnostic transport is not registered. An administrator must establish this fixed Windows prerequisite through DevBridge setup before image construction.' });
  let changed = false;
  let attempted = false;
  try {
    attempted = true;
    const established = await invokeRegistration({ ...request, action: 'establish' });
    changed = established.changed;
    const verified = await inspectWindowsInstallerEvidenceRegistration(request);
    if (established.state !== 'ready' || !changed || verified.state !== 'ready') throw new Error('installer evidence registration did not verify ready');
    return Object.freeze({ ready: true, changed: true, blocker: null });
  } catch {
    // Preserve uncertainty: the next setup invocation observes the native key
    // before it decides whether any establishment is appropriate.
    return Object.freeze({ ready: false, changed, uncertain: attempted, blocker: 'Installer diagnostic registration could not be verified. Setup will re-observe its exact ownership on re-entry; construction remains unavailable.' });
  }
}
