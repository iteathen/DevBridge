import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import { createConfiguredLifecycleAuthorityClient } from '../runtime/environment-lifecycle-authority-transport.js';
import {
  verifyWindowsLifecycleAuthorityAcceptance,
} from './windows-lifecycle-authority-acceptance.js';
import { inspectWindowsLifecycleAuthorityMigrationSafety } from './windows-lifecycle-authority-migration-safety.js';
import { reconcileWindowsLifecycleAuthorityLegacyRuntime } from './windows-lifecycle-authority-legacy-runtime-migration.js';
import { verifyWindowsLifecycleAuthorityService } from './windows-lifecycle-authority-service-proof.js';
import { reconcileWindowsLifecycleAuthorityService } from './windows-lifecycle-authority-service.js';
import { verifyWindowsLifecycleAuthorityProtection } from './windows-lifecycle-authority-protection.js';
import { WINDOWS_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL } from './windows-lifecycle-authority.js';

const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
]);
const MODES = new Set(['ordinary', 'elevated-child']);

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

function legacyRuntimeBlocker(value) {
  return Object.freeze({
    protocol: 'devbridge/windows-lifecycle-authority-service-v1',
    platform: 'win32',
    ready: false,
    blocker: value.blocker ?? 'Legacy Windows protected authority migration did not complete.',
    changed: value.changed === true,
    authorityIdentity: null,
    service: 'legacy-migration-blocked',
    protectedState: 'protected-legacy',
  });
}

function needsElevation(result, host) {
  return host?.elevated === false
    && result?.ready !== true
    && typeof result?.authorityIdentity === 'string'
    && result.service === 'unavailable'
    && result.protectedState === 'unknown';
}

export async function reconcileWindowsLifecycleAuthorityReadiness({
  stateDirectory,
  platform = process.platform,
  invoke = invokeCommand,
  environment = process.env,
  mode = 'ordinary',
  requestElevation = null,
  onDiagnostic = null,
} = {}, {
  migrationSafety = inspectWindowsLifecycleAuthorityMigrationSafety,
  legacyRuntimeMigration = reconcileWindowsLifecycleAuthorityLegacyRuntime,
  serviceReconciler = reconcileWindowsLifecycleAuthorityService,
  inspectHost = inspectWindowsLifecycleAuthorityReadinessHost,
  clientFactory = createConfiguredLifecycleAuthorityClient,
  verifyService = verifyWindowsLifecycleAuthorityService,
  verifyProtection = verifyWindowsLifecycleAuthorityProtection,
  verifyAcceptance = verifyWindowsLifecycleAuthorityAcceptance,
} = {}) {
  if (!MODES.has(mode)) throw new TypeError('Windows lifecycle authority readiness mode is invalid');
  if (requestElevation != null && typeof requestElevation !== 'function') throw new TypeError('Windows lifecycle authority readiness elevation port is invalid');
  if (platform !== 'win32') {
    return serviceReconciler({ stateDirectory, platform, invoke, environment });
  }
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('Windows lifecycle authority readiness stateDirectory is required');
  if (typeof invoke !== 'function') throw new TypeError('Windows lifecycle authority readiness invocation contract is invalid');
  if (typeof migrationSafety !== 'function' || typeof legacyRuntimeMigration !== 'function' || typeof serviceReconciler !== 'function' || typeof inspectHost !== 'function' || typeof clientFactory !== 'function' || typeof verifyService !== 'function' || typeof verifyProtection !== 'function' || typeof verifyAcceptance !== 'function') {
    throw new TypeError('Windows lifecycle authority readiness composition is invalid');
  }

  const migration = await migrationSafety({ stateDirectory, platform });
  if (migration?.ready !== true) return migrationBlocker(migration ?? { blocker: 'Legacy Windows lifecycle authority cannot be migrated safely by the generic protected-state copy path.' });

  let diagnosticOffset = 0;
  if (mode === 'elevated-child') {
    const legacy = await legacyRuntimeMigration({ stateDirectory, platform, invoke, environment, onDiagnostic });
    diagnosticOffset = Array.isArray(legacy?.diagnostics) ? legacy.diagnostics.length : 0;
    if (legacy?.ready !== true) return legacyRuntimeBlocker(legacy ?? {});
  }

  let host = null;
  let protectionFailure = false;
  let verifiedPlan = null;
  const runService = async () => {
    host = null;
    protectionFailure = false;
    verifiedPlan = null;
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
      verifiedPlan = plan;
      return inspection;
    };
    const refreshDiagnostic = onDiagnostic == null ? null : (event) => onDiagnostic(Object.freeze({
      ...event,
      sequence: diagnosticOffset + event.sequence,
    }));
    return serviceReconciler({ stateDirectory, platform, invoke, environment, onDiagnostic: refreshDiagnostic }, {
      inspectHost: composedHostInspection,
      probe: protectedProbe,
    });
  };

  const finalizeOrdinaryReadiness = async (value) => {
    if (value?.ready !== true || host?.elevated !== false) return value;
    if (verifiedPlan?.protocol !== WINDOWS_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL) return value;
    try {
      const acceptance = await verifyAcceptance({
        authorityDirectory: verifiedPlan.authorityDirectory,
        endpoint: verifiedPlan.endpoints?.acceptance?.endpoint,
      });
      if (acceptance?.ready !== true) throw new Error('acceptance not ready');
      return value;
    } catch {
      return withBlocker(
        value,
        'Windows protected lifecycle authority failed its ordinary operational acceptance proof. The construction gate remains closed; re-run devbridge setup after correcting the protected authority boundary.',
      );
    }
  };

  let result = await runService();

  if (mode === 'elevated-child') {
    if (result?.ready === true && host?.elevated === true) return result;
    if (host?.elevated !== true) {
      return withBlocker(result, 'Windows lifecycle authority elevated child did not receive an Administrator token.');
    }
    return result;
  }

  if (result?.ready === true && host?.elevated === false) return finalizeOrdinaryReadiness(result);

  if (result?.ready === true && host?.elevated === true) {
    return withBlocker(
      result,
      'Windows protected lifecycle authority is structurally verified, but final readiness requires the ordinary parent identity. Run devbridge setup from a non-elevated PowerShell.',
    );
  }

  if (needsElevation(result, host) && requestElevation != null) {
    let elevation;
    try { elevation = await requestElevation(); }
    catch {
      return withBlocker(result, 'Windows lifecycle authority elevation could not be started. Re-run devbridge setup to retry the same protected reconciliation.');
    }
    if (elevation?.completed !== true) {
      return withBlocker(result, elevation?.blocker ?? 'Windows lifecycle authority elevation did not complete. Re-run devbridge setup to retry the same protected reconciliation.');
    }
    result = await runService();
    if (result?.ready === true && host?.elevated === false) return finalizeOrdinaryReadiness(result);
    if (result?.ready === true && host?.elevated === true) {
      return withBlocker(result, 'Windows lifecycle authority ordinary parent unexpectedly became elevated; final readiness was not accepted.');
    }
    if (host?.elevated === false && protectionFailure) {
      return withBlocker(
        result,
        'Windows protected lifecycle authority failed its ordinary negative-capability proof after the elevated child returned. The protected state remains closed; re-run devbridge setup after correcting the reported authority boundary.',
      );
    }
    return withBlocker(
      result,
      result?.blocker ?? 'Windows protected lifecycle authority remains not ready after the single elevated child transaction. Re-run devbridge setup to resume from protected evidence.',
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
