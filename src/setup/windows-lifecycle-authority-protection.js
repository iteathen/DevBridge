import { open } from 'node:fs/promises';
import { createConnection } from 'node:net';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-protection-v1';
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
]);
const DENIED_CODES = new Set(['EACCES', 'EPERM']);
const SERVICE_ACCOUNT = /^NT SERVICE\\DevBridgeLifecycle-[0-9a-f]{32}$/u;

const VERIFY_PROTECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$admin = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$service = (New-Object Security.Principal.NTAccount([string]$data.serviceAccount)).Translate([Security.Principal.SecurityIdentifier])
$allow = [Security.AccessControl.AccessControlType]::Allow
$full = [Security.AccessControl.FileSystemRights]::FullControl
$read = [Security.AccessControl.FileSystemRights]::ReadAndExecute
$modify = [Security.AccessControl.FileSystemRights]::Modify
$writeOrDelete = [Security.AccessControl.FileSystemRights]::WriteData -bor
  [Security.AccessControl.FileSystemRights]::AppendData -bor
  [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
  [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
  [Security.AccessControl.FileSystemRights]::Delete -bor
  [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership
$administrative = [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership

function Assert-ProtectedAcl([string]$target, [string]$mode) {
  $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'protection mismatch' }
  $acl = Get-Acl -LiteralPath $target -ErrorAction Stop
  if (-not $acl.AreAccessRulesProtected) { throw 'protection mismatch' }
  if (-not $acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($admin)) { throw 'protection mismatch' }
  $rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 3) { throw 'protection mismatch' }
  $adminSeen = $false
  $systemSeen = $false
  $serviceSeen = $false
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne $allow -or $rule.IsInherited) { throw 'protection mismatch' }
    $sid = $rule.IdentityReference
    $rights = $rule.FileSystemRights
    if ($sid.Equals($admin)) {
      if (($rights -band $full) -ne $full) { throw 'protection mismatch' }
      $adminSeen = $true
    } elseif ($sid.Equals($system)) {
      if (($rights -band $full) -ne $full) { throw 'protection mismatch' }
      $systemSeen = $true
    } elseif ($sid.Equals($service)) {
      if ($mode -eq 'read') {
        if (($rights -band $read) -ne $read -or ($rights -band $writeOrDelete) -ne 0) { throw 'protection mismatch' }
      } elseif ($mode -eq 'modify') {
        if (($rights -band $modify) -ne $modify -or ($rights -band $administrative) -ne 0) { throw 'protection mismatch' }
      } else { throw 'protection mismatch' }
      $serviceSeen = $true
    } else { throw 'protection mismatch' }
  }
  if (-not $adminSeen -or -not $systemSeen -or -not $serviceSeen) { throw 'protection mismatch' }
}

Assert-ProtectedAcl ([string]$data.protectedRoot) 'read'
Assert-ProtectedAcl ([string]$data.authorityDirectory) 'modify'
Assert-ProtectedAcl ([string]$data.binDirectory) 'read'
Assert-ProtectedAcl ([string]$data.runtimeDirectory) 'read'
Assert-ProtectedAcl ([string]$data.packageDirectory) 'read'
Assert-ProtectedAcl ([string]$data.nodeExecutable) 'read'
Assert-ProtectedAcl ([string]$data.serviceHostExecutable) 'read'
Assert-ProtectedAcl ([string]$data.workerEntry) 'read'

$members = @(Get-LocalGroupMember -SID ([string]$data.hyperVGroupSid) -ErrorAction Stop)
$serviceMember = @($members | Where-Object { $_.SID -and $_.SID.Value -eq $service.Value }).Count -eq 1
if (-not $serviceMember) { throw 'protection mismatch' }
@{ ready = $true } | ConvertTo-Json -Compress
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function invocationSucceeded(result) {
  return result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true && result?.outputTruncated !== true;
}

function requirePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('Windows lifecycle authority protection plan is required');
  if (typeof plan?.service?.account !== 'string' || !SERVICE_ACCOUNT.test(plan.service.account)) throw new TypeError('Windows lifecycle authority protection service account is invalid');
  if (typeof plan?.service?.hyperVGroupSid !== 'string' || plan.service.hyperVGroupSid.length === 0) throw new TypeError('Windows lifecycle authority protection group is invalid');
  for (const value of [
    plan.protectedRoot,
    plan.authorityDirectory,
    plan.ownershipManifest,
    plan?.runtime?.binDirectory,
    plan?.runtime?.runtimeDirectory,
    plan?.runtime?.packageDirectory,
    plan?.runtime?.nodeExecutable,
    plan?.runtime?.serviceHostExecutable,
    plan?.runtime?.workerEntry,
    plan?.endpoints?.mutation?.endpoint,
  ]) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError('Windows lifecycle authority protection plan is incomplete');
  }
  return plan;
}

async function verifyStructuralProtection(plan, invoke, environment) {
  let result;
  try {
    result = await invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(VERIFY_PROTECTION_SCRIPT)],
      input: JSON.stringify({
        protectedRoot: plan.protectedRoot,
        authorityDirectory: plan.authorityDirectory,
        binDirectory: plan.runtime.binDirectory,
        runtimeDirectory: plan.runtime.runtimeDirectory,
        packageDirectory: plan.runtime.packageDirectory,
        nodeExecutable: plan.runtime.nodeExecutable,
        serviceHostExecutable: plan.runtime.serviceHostExecutable,
        workerEntry: plan.runtime.workerEntry,
        serviceAccount: plan.service.account,
        hyperVGroupSid: plan.service.hyperVGroupSid,
      }),
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
      environment,
    });
  } catch {
    throw new Error('Windows lifecycle authority structural protection proof could not execute');
  }
  if (!invocationSucceeded(result)) throw new Error('Windows lifecycle authority structural protection proof failed');
  try {
    const value = JSON.parse(String(result.stdout ?? '').trim());
    if (value?.ready !== true || Object.keys(value).some((key) => key !== 'ready')) throw new Error('invalid evidence');
  } catch {
    throw new Error('Windows lifecycle authority structural protection proof returned invalid evidence');
  }
}

async function proveOwnershipWriteDenied(ownershipManifest) {
  let handle;
  try {
    handle = await open(ownershipManifest, 'r+');
  } catch (error) {
    if (DENIED_CODES.has(error?.code)) return;
    throw new Error('Windows lifecycle authority protected-state denial could not be proved');
  }
  try {
    throw new Error('Windows lifecycle authority protected state remains writable by the ordinary setup identity');
  } finally {
    await handle.close();
  }
}

async function proveMutationConnectionDenied(endpoint) {
  await new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Windows lifecycle authority mutation-endpoint denial could not be proved')), 3_000);
    try {
      socket = createConnection(endpoint);
    } catch {
      finish(new Error('Windows lifecycle authority mutation-endpoint denial could not be proved'));
      return;
    }
    socket.once('connect', () => finish(new Error('Windows lifecycle authority mutation endpoint is accessible to the ordinary setup identity')));
    socket.once('error', (error) => {
      if (DENIED_CODES.has(error?.code)) finish();
      else finish(new Error('Windows lifecycle authority mutation-endpoint denial could not be proved'));
    });
  });
}

export async function verifyWindowsLifecycleAuthorityProtection({
  plan,
  elevated,
  invoke = invokeCommand,
  environment = process.env,
} = {}, {
  structuralProof = verifyStructuralProtection,
  ownershipWriteDenied = proveOwnershipWriteDenied,
  mutationConnectionDenied = proveMutationConnectionDenied,
} = {}) {
  const selected = requirePlan(plan);
  if (typeof elevated !== 'boolean') throw new TypeError('Windows lifecycle authority protection elevation state is required');
  if (typeof invoke !== 'function') throw new TypeError('Windows lifecycle authority protection invocation contract is invalid');

  if (elevated) {
    await structuralProof(selected, invoke, environment);
    return Object.freeze({ protocol: PROTOCOL, ready: true, mode: 'structural' });
  }

  await ownershipWriteDenied(selected.ownershipManifest);
  await mutationConnectionDenied(selected.endpoints.mutation.endpoint);
  return Object.freeze({ protocol: PROTOCOL, ready: true, mode: 'ordinary-negative' });
}

export { PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_PROTECTION_PROTOCOL };
