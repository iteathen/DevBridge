import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-service-proof-v1';
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
]);
const SERVICE_NAME = /^DevBridgeLifecycle-[0-9a-f]{32}$/u;
const WINDOWS_SID = /^S-1-(?:\d+-)+\d+$/u;

const VERIFY_SERVICE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$escaped = ([string]$data.name).Replace("'", "''")
$service = Get-CimInstance Win32_Service -Filter ("Name='" + $escaped + "'") -ErrorAction Stop
if ($null -eq $service) {
  @{ ready = $false } | ConvertTo-Json -Compress
  exit 0
}
$stateReady = [String]::Equals([string]$service.State, 'Running', [StringComparison]::OrdinalIgnoreCase)
$startReady = [String]::Equals([string]$service.StartMode, 'Auto', [StringComparison]::OrdinalIgnoreCase)
$accountReady = [String]::Equals([string]$service.StartName, [string]$data.account, [StringComparison]::OrdinalIgnoreCase)
$commandReady = [String]::Equals([string]$service.PathName, [string]$data.command, [StringComparison]::OrdinalIgnoreCase)
$ready = $stateReady -and $startReady -and $accountReady -and $commandReady
@{ ready = [bool]$ready } | ConvertTo-Json -Compress
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function invocationSucceeded(result) {
  return result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true && result?.outputTruncated !== true;
}

function quoted(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function expectedServiceCommand(plan, operatorSid) {
  const fields = [
    plan.runtime.serviceHostExecutable,
    '--service-name', plan.service.name,
    '--protected-root', plan.protectedRoot,
    '--node', plan.runtime.nodeExecutable,
    '--worker', plan.runtime.workerEntry,
    '--state-directory', plan.stateDirectory,
    '--authority-directory', plan.authorityDirectory,
    '--operator-sid', operatorSid,
    '--read-pipe', plan.endpoints.read.pipeName,
    '--mutation-pipe', plan.endpoints.mutation.pipeName,
  ];
  return fields.map(quoted).join(' ');
}

function requirePlan(plan, operatorSid) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('Windows lifecycle authority service proof plan is required');
  if (typeof operatorSid !== 'string' || !WINDOWS_SID.test(operatorSid)) throw new TypeError('Windows lifecycle authority service proof operator SID is invalid');
  if (typeof plan?.service?.name !== 'string' || !SERVICE_NAME.test(plan.service.name)) {
    throw new TypeError('Windows lifecycle authority service proof identity is invalid');
  }
  if (plan?.service?.account !== `NT SERVICE\\${plan.service.name}`) {
    throw new TypeError('Windows lifecycle authority service proof identity is invalid');
  }
  for (const value of [
    plan.protectedRoot,
    plan.stateDirectory,
    plan.authorityDirectory,
    plan?.runtime?.serviceHostExecutable,
    plan?.runtime?.nodeExecutable,
    plan?.runtime?.workerEntry,
    plan?.endpoints?.read?.pipeName,
    plan?.endpoints?.mutation?.pipeName,
  ]) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError('Windows lifecycle authority service proof plan is incomplete');
  }
  return plan;
}

export async function verifyWindowsLifecycleAuthorityService({
  plan,
  operatorSid,
  invoke = invokeCommand,
  environment = process.env,
} = {}) {
  const selected = requirePlan(plan, operatorSid);
  if (typeof invoke !== 'function') throw new TypeError('Windows lifecycle authority service proof invocation contract is invalid');

  let result;
  try {
    result = await invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(VERIFY_SERVICE_SCRIPT)],
      input: JSON.stringify({
        name: selected.service.name,
        account: selected.service.account,
        command: expectedServiceCommand(selected, operatorSid),
      }),
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      environment,
    });
  } catch {
    throw new Error('Windows lifecycle authority service identity proof could not execute');
  }
  if (!invocationSucceeded(result)) throw new Error('Windows lifecycle authority service identity proof failed');
  try {
    const value = JSON.parse(String(result.stdout ?? '').trim());
    if (value?.ready !== true || Object.keys(value).some((key) => key !== 'ready')) throw new Error('invalid evidence');
  } catch {
    throw new Error('Windows lifecycle authority service identity proof did not verify the exact protected service');
  }
  return Object.freeze({ protocol: PROTOCOL, ready: true });
}

export { PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_SERVICE_PROOF_PROTOCOL };
