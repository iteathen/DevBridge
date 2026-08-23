import { reconcileWindowsSignatureVerifier } from './windows-signature-verifier-prerequisite.js';

const PROTOCOL = 'devbridge/setup-prerequisites-v1';
const OPENSSH_CLIENT_CAPABILITY = 'OpenSSH.Client~~~~0.0.1.0';
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
]);

const WINDOWS_OPENSSH_INSPECTION = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$ssh = [bool](Get-Command 'ssh.exe' -ErrorAction SilentlyContinue)
$sshKeygen = [bool](Get-Command 'ssh-keygen.exe' -ErrorAction SilentlyContinue)
$state = $null
if ($elevated -and (-not ($ssh -and $sshKeygen))) {
  $capability = Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -ErrorAction Stop
  $state = [string]$capability.State
}
@{
  elevated = [bool]$elevated
  ssh = [bool]$ssh
  sshKeygen = [bool]$sshKeygen
  capabilityState = $state
} | ConvertTo-Json -Compress
`;

const WINDOWS_OPENSSH_ESTABLISHMENT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$result = Add-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -ErrorAction Stop
@{
  restartNeeded = [bool]$result.RestartNeeded
} | ConvertTo-Json -Compress
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function boundedReason(value, fallback) {
  const text = String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
  return text.length > 0 ? text.slice(0, 1024) : fallback;
}

function invocationSucceeded(result) {
  return result?.exitCode === 0 &&
    result?.timedOut !== true &&
    result?.aborted !== true &&
    result?.outputTruncated !== true;
}

async function usableExecutable(invoke, executable, environment) {
  try {
    const result = await invoke({
      executable,
      arguments: ['--version'],
      input: null,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
      environment,
    });
    return invocationSucceeded(result);
  } catch {
    return false;
  }
}

function parseStructuredInvocation(result, operation) {
  if (!invocationSucceeded(result)) {
    const reason = boundedReason(result?.stderr || result?.stdout, `${operation} failed`);
    throw new Error(`${operation} failed: ${reason}`);
  }
  try {
    const value = JSON.parse(String(result.stdout ?? ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`${operation} returned invalid structured output`);
  }
}

async function invokePowerShell(invoke, script, operation, environment) {
  let result;
  try {
    result = await invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(script)],
      input: null,
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
      environment,
    });
  } catch (error) {
    throw new Error(`${operation} could not execute: ${boundedReason(error?.message, 'PowerShell is unavailable')}`);
  }
  return parseStructuredInvocation(result, operation);
}

function result({ platform, ready, blocker = null, changed = false, restartRequired = false, capabilities = {}, local = null }) {
  const value = {
    protocol: PROTOCOL,
    platform,
    ready,
    blocker,
    changed,
    restartRequired,
    capabilities: Object.freeze({ ...capabilities }),
  };
  if (local) value.local = Object.freeze({ ...local });
  return Object.freeze(value);
}

function gpgvBlocker() {
  return 'GPG signature verification is unavailable because gpgv is not usable. Install the platform gpgv package, then re-run devbridge setup.';
}

async function inspectWindowsOpenSsh(invoke, environment) {
  const inspected = await invokePowerShell(
    invoke,
    WINDOWS_OPENSSH_INSPECTION,
    'Windows OpenSSH Client inspection',
    environment,
  );
  if (typeof inspected.elevated !== 'boolean' ||
      typeof inspected.ssh !== 'boolean' ||
      typeof inspected.sshKeygen !== 'boolean' ||
      (inspected.capabilityState != null && typeof inspected.capabilityState !== 'string')) {
    throw new Error('Windows OpenSSH Client inspection returned an invalid capability record');
  }
  return Object.freeze({
    elevated: inspected.elevated,
    ssh: inspected.ssh,
    sshKeygen: inspected.sshKeygen,
    capabilityState: inspected.capabilityState,
  });
}

async function establishWindowsOpenSsh(invoke, environment) {
  const established = await invokePowerShell(
    invoke,
    WINDOWS_OPENSSH_ESTABLISHMENT,
    'Windows OpenSSH Client establishment',
    environment,
  );
  if (typeof established.restartNeeded !== 'boolean') {
    throw new Error('Windows OpenSSH Client establishment returned an invalid result');
  }
  return established;
}

export async function reconcileSetupPrerequisites({
  platform = process.platform,
  invoke,
  fetchImpl = globalThis.fetch,
  environment = process.env,
} = {}, {
  windowsSignatureVerifier = reconcileWindowsSignatureVerifier,
} = {}) {
  if (typeof platform !== 'string' || platform.length === 0) {
    throw new TypeError('setup prerequisite platform is invalid');
  }
  if (typeof invoke !== 'function') {
    throw new TypeError('setup prerequisite invocation contract is invalid');
  }

  let signatureChanged = false;
  let signatureVerifierExecutable;

  if (platform === 'win32') {
    let signature;
    try {
      signature = await windowsSignatureVerifier({ invoke, fetchImpl, environment });
    } catch (error) {
      return result({
        platform,
        ready: false,
        blocker: `Windows signature-verification prerequisite reconciliation failed: ${boundedReason(error?.message, 'unknown failure')}`,
        capabilities: { gpgv: false, opensshClient: null },
      });
    }
    signatureChanged = signature?.changed === true;
    if (signature?.ready !== true) {
      return result({
        platform,
        ready: false,
        blocker: signature?.blocker ?? 'Windows signature-verification prerequisite is not ready; re-run devbridge setup after resolving the reported host boundary.',
        changed: signatureChanged,
        capabilities: { gpgv: false, opensshClient: null },
      });
    }
    if (typeof signature.executable !== 'string' || signature.executable.length === 0 || signature.executable.includes('\0')) {
      return result({
        platform,
        ready: false,
        blocker: 'Windows signature-verification prerequisite reported readiness without a usable local executable binding.',
        changed: signatureChanged,
        capabilities: { gpgv: false, opensshClient: null },
      });
    }
    signatureVerifierExecutable = signature.executable;
  } else {
    const gpgv = await usableExecutable(invoke, 'gpgv', environment);
    if (!gpgv) {
      return result({
        platform,
        ready: false,
        blocker: gpgvBlocker(),
        capabilities: { gpgv: false, opensshClient: 'not-applicable' },
      });
    }
    signatureVerifierExecutable = 'gpgv';
  }

  const local = { signatureVerifierExecutable };

  if (platform !== 'win32') {
    return result({
      platform,
      ready: true,
      capabilities: { gpgv: true, opensshClient: 'not-applicable' },
      local,
    });
  }

  let inspected;
  try {
    inspected = await inspectWindowsOpenSsh(invoke, environment);
  } catch (error) {
    return result({
      platform,
      ready: false,
      blocker: `${error.message}. Repair Windows servicing/PowerShell availability, then re-run devbridge setup.`,
      changed: signatureChanged,
      capabilities: { gpgv: true, opensshClient: false },
      local,
    });
  }

  if (inspected.ssh && inspected.sshKeygen) {
    return result({
      platform,
      ready: true,
      changed: signatureChanged,
      capabilities: { gpgv: true, opensshClient: true },
      local,
    });
  }

  if (!inspected.elevated) {
    return result({
      platform,
      ready: false,
      blocker: `Windows OpenSSH Client is not usable. Re-run devbridge setup from an elevated PowerShell so DevBridge can inspect and, when safe, establish ${OPENSSH_CLIENT_CAPABILITY}.`,
      changed: signatureChanged,
      capabilities: { gpgv: true, opensshClient: false },
      local,
    });
  }

  if (inspected.capabilityState !== 'NotPresent') {
    const state = inspected.capabilityState ?? 'unknown';
    const restartRequired = /Pending/u.test(state);
    return result({
      platform,
      ready: false,
      restartRequired,
      blocker: restartRequired
        ? `Windows OpenSSH Client servicing is ${state}. Restart Windows if requested, then re-run devbridge setup.`
        : `Windows reports OpenSSH Client capability state ${state}, but ssh.exe and ssh-keygen.exe are not both usable. Repair the Windows capability, then re-run devbridge setup.`,
      changed: signatureChanged,
      capabilities: { gpgv: true, opensshClient: false },
      local,
    });
  }

  let established;
  try {
    established = await establishWindowsOpenSsh(invoke, environment);
  } catch (error) {
    return result({
      platform,
      ready: false,
      blocker: `${error.message}. Windows servicing policy or its feature source may require operator action; resolve that boundary, then re-run devbridge setup.`,
      changed: signatureChanged,
      capabilities: { gpgv: true, opensshClient: false },
      local,
    });
  }

  if (established.restartNeeded) {
    return result({
      platform,
      ready: false,
      changed: true,
      restartRequired: true,
      blocker: 'Windows OpenSSH Client was established, but Windows requires a restart before setup can verify readiness. Restart Windows, then re-run devbridge setup.',
      capabilities: { gpgv: true, opensshClient: false },
      local,
    });
  }

  let verified;
  try {
    verified = await inspectWindowsOpenSsh(invoke, environment);
  } catch (error) {
    return result({
      platform,
      ready: false,
      changed: true,
      blocker: `${error.message}. OpenSSH Client was established but readiness could not be verified; re-run devbridge setup after repairing Windows servicing/PowerShell.`,
      capabilities: { gpgv: true, opensshClient: false },
      local,
    });
  }

  if (!verified.ssh || !verified.sshKeygen) {
    return result({
      platform,
      ready: false,
      changed: true,
      blocker: 'Windows OpenSSH Client establishment completed, but ssh.exe and ssh-keygen.exe are not both usable. Repair the Windows capability, then re-run devbridge setup.',
      capabilities: { gpgv: true, opensshClient: false },
      local,
    });
  }

  return result({
    platform,
    ready: true,
    changed: signatureChanged || true,
    capabilities: { gpgv: true, opensshClient: true },
    local,
  });
}

export { PROTOCOL as SETUP_PREREQUISITES_PROTOCOL };
