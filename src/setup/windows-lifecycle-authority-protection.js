import { open } from 'node:fs/promises';
import { createConnection } from 'node:net';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import {
  WINDOWS_HYPERV_ADMINISTRATORS_SID,
  WINDOWS_NETWORK_CONFIGURATION_OPERATORS_SID,
} from './windows-lifecycle-authority.js';

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

function Assert-ProtectedAcl([string]$target, [string]$mode, [bool]$requireProtected, [string]$label) {
  $script:current = $label
  $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-point' }
  $acl = Get-Acl -LiteralPath $target -ErrorAction Stop
  if ($requireProtected -and -not $acl.AreAccessRulesProtected) { throw 'inheritance-enabled' }
  if (-not $acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($admin)) { throw 'owner' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 3) { throw 'ace-count' }
  $adminSeen = $false
  $systemSeen = $false
  $serviceSeen = $false
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne $allow) { throw 'ace-type' }
    $sid = $rule.IdentityReference
    $rights = $rule.FileSystemRights
    if ($sid.Equals($admin)) {
      if (($rights -band $full) -ne $full) { throw 'administrators-rights' }
      $adminSeen = $true
    } elseif ($sid.Equals($system)) {
      if (($rights -band $full) -ne $full) { throw 'system-rights' }
      $systemSeen = $true
    } elseif ($sid.Equals($service)) {
      if ($mode -eq 'read') {
        if (($rights -band $read) -ne $read -or ($rights -band $writeOrDelete) -ne 0) { throw 'service-read-rights' }
      } elseif ($mode -eq 'modify') {
        if (($rights -band $modify) -ne $modify -or ($rights -band $administrative) -ne 0) { throw 'service-modify-rights' }
      } else { throw 'mode' }
      $serviceSeen = $true
    } else { throw 'unexpected-principal' }
  }
  if (-not $adminSeen -or -not $systemSeen -or -not $serviceSeen) { throw 'required-principal' }
}

$checks = @()
$script:current = 'admission'
try {
  Assert-ProtectedAcl ([string]$data.protectedRoot) 'read' $true 'protected-root'; $checks += 'protected-root'
  Assert-ProtectedAcl ([string]$data.authorityDirectory) 'modify' $true 'authority-directory'; $checks += 'authority-directory'
  Assert-ProtectedAcl ([string]$data.generationsDirectory) 'read' $false 'generations-directory'; $checks += 'generations-directory'
  Assert-ProtectedAcl ([string]$data.generationDirectory) 'read' $false 'generation-directory'; $checks += 'generation-directory'
  Assert-ProtectedAcl ([string]$data.binDirectory) 'read' $false 'bin-directory'; $checks += 'bin-directory'
  Assert-ProtectedAcl ([string]$data.runtimeDirectory) 'read' $false 'runtime-directory'; $checks += 'runtime-directory'
  Assert-ProtectedAcl ([string]$data.packageDirectory) 'read' $false 'package-directory'; $checks += 'package-directory'
  Assert-ProtectedAcl ([string]$data.nodeExecutable) 'read' $false 'node-executable'; $checks += 'node-executable'
  Assert-ProtectedAcl ([string]$data.serviceHostExecutable) 'read' $false 'service-host-executable'; $checks += 'service-host-executable'
  Assert-ProtectedAcl ([string]$data.workerEntry) 'read' $false 'worker-entry'; $checks += 'worker-entry'
  foreach ($groupSid in @($data.retiredCapabilityGroupSids)) {
    $script:current = 'capability-membership-retirement'
    $members = @(Get-LocalGroupMember -SID ([string]$groupSid) -ErrorAction Stop)
    $serviceMembers = @($members | Where-Object { $_.SID -and $_.SID.Value -eq $service.Value })
    if ($serviceMembers.Count -ne 0) { throw 'stale-service-member' }
  }
  $checks += 'capability-membership-retirement'
  @{ ready = $true; checks = $checks } | ConvertTo-Json -Compress
} catch {
  @{ ready = $false; checks = $checks; failed = $script:current; reason = [string]$_.Exception.Message } | ConvertTo-Json -Compress
}
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
  const retiredCapabilityGroupSids = plan?.service?.retiredCapabilityGroupSids;
  if (!Array.isArray(retiredCapabilityGroupSids)
    || retiredCapabilityGroupSids.length !== 2
    || retiredCapabilityGroupSids[0] !== WINDOWS_HYPERV_ADMINISTRATORS_SID
    || retiredCapabilityGroupSids[1] !== WINDOWS_NETWORK_CONFIGURATION_OPERATORS_SID) {
    throw new TypeError('Windows lifecycle authority protection retired capability groups are invalid');
  }
  for (const value of [
    plan.protectedRoot,
    plan.authorityDirectory,
    plan.ownershipManifest,
    plan?.runtime?.generationsDirectory,
    plan?.runtime?.generationDirectory,
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
        generationsDirectory: plan.runtime.generationsDirectory,
        generationDirectory: plan.runtime.generationDirectory,
        binDirectory: plan.runtime.binDirectory,
        runtimeDirectory: plan.runtime.runtimeDirectory,
        packageDirectory: plan.runtime.packageDirectory,
        nodeExecutable: plan.runtime.nodeExecutable,
        serviceHostExecutable: plan.runtime.serviceHostExecutable,
        workerEntry: plan.runtime.workerEntry,
        serviceAccount: plan.service.account,
        retiredCapabilityGroupSids: plan.service.retiredCapabilityGroupSids,
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
    const allowed = new Set(['ready', 'checks', 'failed', 'reason']);
    if (!value || typeof value.ready !== 'boolean' || Object.keys(value).some((key) => !allowed.has(key))) throw new Error('invalid evidence');
    if (value.ready !== true) {
      const failed = String(value.failed ?? 'unknown');
      const reason = String(value.reason ?? 'unknown');
      if (!/^[a-z0-9-]{1,64}$/u.test(failed) || !/^[a-z0-9-]{1,64}$/u.test(reason)) throw new Error('invalid evidence');
      throw new Error(`proof mismatch ${failed}:${reason}`);
    }
  } catch (error) {
    if (String(error?.message ?? '').startsWith('proof mismatch ')) {
      throw new Error(`Windows lifecycle authority structural protection proof failed: ${error.message.slice('proof mismatch '.length)}`);
    }
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
