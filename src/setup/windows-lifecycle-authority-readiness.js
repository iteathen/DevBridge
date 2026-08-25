import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import { createConfiguredLifecycleAuthorityClient } from '../runtime/environment-lifecycle-authority-transport.js';
import { inspectWindowsLifecycleAuthorityMigrationSafety } from './windows-lifecycle-authority-migration-safety.js';
import { verifyWindowsLifecycleAuthorityService } from './windows-lifecycle-authority-service-proof.js';
import { reconcileWindowsLifecycleAuthorityService } from './windows-lifecycle-authority-service.js';
import { verifyWindowsLifecycleAuthorityProtection } from './windows-lifecycle-authority-protection.js';

const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
]);

const HOST_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
@{
  elevated = [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  operatorSid = [string]$identity.User.Value
  programData = [string][Environment]::GetFolderPath('CommonApplicationData')
} | ConvertTo-Json -Compress
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function invocationSucceeded(result) {
  return result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true && result?.outputTruncated !== true;
}

async function inspectWindowsLifecycleAuthorityReadinessHost({ invoke, environment }) {
  let result;
  try {
    result = await invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(HOST_INSPECTION_SCRIPT)],
      input: null,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      environment,
    });
  } catch {
    throw new Error('Windows lifecycle authority readiness host inspection could not execute');
  }
  if (!invocationSucceeded(result)) throw new Error('Windows lifecycle authority readiness host inspection failed');
  try {
    const value = JSON.parse(String(result.stdout ?? '').trim());
    if (typeof value?.elevated !== 'boolean' || typeof value?.operatorSid !== 'string' || typeof value?.programData !== 'string') throw new Error('invalid evidence');
    return Object.freeze({ elevated: value.elevated, operatorSid: value.operatorSid, programData: value.programData });
  } catch {
    throw new Error('Windows lifecycle authority readiness host inspection returned invalid evidence');
  }
}

function verifiedInspection(value) {
  if (!value || value.protocol !== 'devbridge/environment-operator-v1') {
    throw new Error('protected lifecycle authority returned invalid inspection evidence');
  }
  return value;
}

function withBlocker(result, blocker) {
  return Object.freeze({ ...result, ready: false, blocker });
}

function migrationBlocker(value) {
  return Object.freeze({
    protocol: 'devbridge/windows-lifecycle-authority-service-v1',
    platform: 'win32',
    ready: false,
    blocker: value.blocker,
    changed: false,
    authorityIdentity: null,
    service: 'migration-required',
    protectedState: 'legacy-unprotected',
  });
}

export async function reconcileWindowsLifecycleAuthorityReadiness({
  stateDirectory,
  platform = process.platform,
  invoke = invokeCommand,
  environment = process.env,
} = {}, {
  migrationSafety = inspectWindowsLifecycleAuthorityMigrationSafety,
  serviceReconciler = reconcileWindowsLifecycleAuthorityService,
  inspectHost = inspectWindowsLifecycleAuthorityReadinessHost,
  clientFactory = createConfiguredLifecycleAuthorityClient,
  verifyService = verifyWindowsLifecycleAuthorityService,
  verifyProtection = verifyWindowsLifecycleAuthorityProtection,
} = {}) {
  if (platform !== 'win32') {
    return serviceReconciler({ stateDirectory, platform, invoke, environment });
  }
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('Windows lifecycle authority readiness stateDirectory is required');
  if (typeof invoke !== 'function') throw new TypeError('Windows lifecycle authority readiness invocation contract is invalid');
  if (typeof migrationSafety !== 'function' || typeof serviceReconciler !== 'function' || typeof inspectHost !== 'function' || typeof clientFactory !== 'function' || typeof verifyService !== 'function' || typeof verifyProtection !== 'function') {
    throw new TypeError('Windows lifecycle authority readiness composition is invalid');
  }

  const migration = await migrationSafety({ stateDirectory, platform });
  if (migration?.ready !== true) return migrationBlocker(migration ?? { blocker: 'Legacy Windows lifecycle authority cannot be migrated safely by the generic protected-state copy path.' });

  let host = null;
  let protectionFailure = false;
  const composedHostInspection = async (request) => {
    host = await inspectHost(request);
    return host;
  };
  const protectedProbe = async (plan) => {
    await verifyService({ plan, operatorSid: host?.operatorSid, invoke, environment });
    const client = clientFactory({ stateDirectory: plan.stateDirectory, platform: 'win32', connectTimeoutMs: 3_000 });
    const inspection = verifiedInspection(await client.inspect());
    try {
      await verifyProtection({ plan, elevated: host?.elevated, invoke, environment });
    } catch (error) {
      protectionFailure = true;
      throw error;
    }
    return inspection;
  };

  const result = await serviceReconciler({ stateDirectory, platform, invoke, environment }, {
    inspectHost: composedHostInspection,
    probe: protectedProbe,
  });

  if (result?.ready === true && host?.elevated === true) {
    return withBlocker(
      result,
      'Windows protected lifecycle authority is structurally verified. Re-run devbridge setup from a non-elevated PowerShell to prove ordinary protected-state and mutation-endpoint denial before construction can continue.',
    );
  }
  if (result?.ready !== true && host?.elevated === false && protectionFailure) {
    return withBlocker(
      result,
      'Windows protected lifecycle authority failed its ordinary negative-capability proof. Re-run devbridge setup from an elevated PowerShell to reconcile the protected service and state boundary.',
    );
  }
  return result;
}
