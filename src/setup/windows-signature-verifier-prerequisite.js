import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PROTOCOL = 'devbridge/windows-signature-verifier-prerequisite-v1';
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
]);

export const WINDOWS_SIGNATURE_VERIFIER_SOURCE_POLICY = Object.freeze({
  url: 'https://gnupg.org/ftp/gcrypt/binary/gnupg-w32-2.5.21_20260702.exe',
  sha256: '6246c925a73167253444afc24a0deb83a3f43b7d636af84d6aaf48a98a62f024',
  fileName: 'gnupg-w32-2.5.21_20260702.exe',
  maxBytes: 8 * 1024 * 1024,
});

const WINDOWS_INSPECTION = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$priorPath = $env:Path
try {
  $parts = @(
    [Environment]::GetEnvironmentVariable('Path', 'Process'),
    [Environment]::GetEnvironmentVariable('Path', 'Machine'),
    [Environment]::GetEnvironmentVariable('Path', 'User')
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  $env:Path = ($parts -join ';')
  $command = Get-Command 'gpgv.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $executable = if ($null -eq $command) { $null } else { [string]$command.Source }
  if ($null -eq $executable) {
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    foreach ($root in $roots) {
      $candidate = Join-Path $root 'GnuPG\bin\gpgv.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $executable = [string](Get-Item -LiteralPath $candidate -Force).FullName
        break
      }
    }
  }
} finally {
  $env:Path = $priorPath
}
@{
  elevated = [bool]$elevated
  executable = $executable
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

function record({ ready, changed = false, blocker = null, executable = null }) {
  return Object.freeze({
    protocol: PROTOCOL,
    ready,
    changed,
    blocker,
    executable,
  });
}

function sourcePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Windows signature-verification source policy is invalid');
  if (typeof value.url !== 'string' || !value.url.startsWith('https://') || value.url.includes('\0')) throw new TypeError('Windows signature-verification source URL is invalid');
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new TypeError('Windows signature-verification source digest is invalid');
  if (typeof value.fileName !== 'string' || !/^[A-Za-z0-9._-]+\.exe$/u.test(value.fileName)) throw new TypeError('Windows signature-verification source filename is invalid');
  if (!Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1024 * 1024 || value.maxBytes > 128 * 1024 * 1024) throw new TypeError('Windows signature-verification source size bound is invalid');
  return value;
}

async function inspect(invoke, environment) {
  let response;
  try {
    response = await invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(WINDOWS_INSPECTION)],
      input: null,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      environment,
    });
  } catch (error) {
    throw new Error(`Windows prerequisite inspection could not execute: ${boundedReason(error?.message, 'PowerShell is unavailable')}`);
  }
  if (!invocationSucceeded(response)) {
    throw new Error(`Windows prerequisite inspection failed: ${boundedReason(response?.stderr || response?.stdout, 'PowerShell inspection failed')}`);
  }

  let value;
  try {
    value = JSON.parse(String(response.stdout ?? ''));
  } catch {
    throw new Error('Windows prerequisite inspection returned invalid structured output');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.elevated !== 'boolean') {
    throw new Error('Windows prerequisite inspection returned an invalid capability record');
  }
  if (value.executable != null && (typeof value.executable !== 'string' || value.executable.includes('\0') || !path.win32.isAbsolute(value.executable))) {
    throw new Error('Windows prerequisite inspection returned an invalid executable binding');
  }
  return Object.freeze({ elevated: value.elevated, executable: value.executable ?? null });
}

async function usableExecutable(invoke, executable, environment) {
  if (!executable) return false;
  try {
    const response = await invoke({
      executable,
      arguments: ['--version'],
      input: null,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
      environment,
    });
    return invocationSucceeded(response);
  } catch {
    return false;
  }
}

async function boundedFetch(fetchImpl, policy) {
  let response;
  try {
    response = await fetchImpl(policy.url, { redirect: 'error' });
  } catch (error) {
    throw new Error(`approved package request failed: ${boundedReason(error?.message, 'network request failed')}`);
  }
  if (!response?.ok) throw new Error(`approved package request failed (${response?.status ?? 'unknown'})`);
  const length = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isFinite(length) && length > policy.maxBytes) throw new Error('approved package exceeds its size bound');

  const chunks = [];
  let total = 0;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > policy.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('approved package exceeds its size bound');
      }
      chunks.push(chunk);
    }
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    total = bytes.length;
    if (total > policy.maxBytes) throw new Error('approved package exceeds its size bound');
    chunks.push(bytes);
  }

  if (total < 1) throw new Error('approved package response is empty');
  const bytes = Buffer.concat(chunks, total);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== policy.sha256) throw new Error('approved package digest does not match runtime-owned source policy');
  return bytes;
}

async function install(invoke, fetchImpl, environment, policy) {
  const bytes = await boundedFetch(fetchImpl, policy);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-signature-verifier-'));
  const installer = path.join(directory, policy.fileName);
  try {
    await writeFile(installer, bytes, { mode: 0o700 });
    let response;
    try {
      response = await invoke({
        executable: installer,
        arguments: ['/S'],
        input: null,
        timeoutMs: 300_000,
        maxOutputBytes: 256 * 1024,
        environment,
      });
    } catch (error) {
      throw new Error(`approved package installer could not execute: ${boundedReason(error?.message, 'installation failed')}`);
    }
    if (!invocationSucceeded(response)) {
      throw new Error(`approved package installer failed: ${boundedReason(response?.stderr || response?.stdout, `exit ${response?.exitCode ?? 'unknown'}`)}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function reconcileWindowsSignatureVerifier({
  invoke,
  fetchImpl = globalThis.fetch,
  environment = process.env,
  policy = WINDOWS_SIGNATURE_VERIFIER_SOURCE_POLICY,
} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('Windows signature-verification invocation contract is invalid');
  if (typeof fetchImpl !== 'function') throw new TypeError('Windows signature-verification fetch contract is invalid');
  const approved = sourcePolicy(policy);

  let observed;
  try {
    observed = await inspect(invoke, environment);
  } catch (error) {
    return record({ ready: false, blocker: `${error.message}. Repair PowerShell availability, then re-run devbridge setup.` });
  }

  if (observed.executable && await usableExecutable(invoke, observed.executable, environment)) {
    return record({ ready: true, executable: observed.executable });
  }

  if (!observed.elevated) {
    return record({
      ready: false,
      blocker: 'Windows signature verification is unavailable. Re-run devbridge setup from an elevated PowerShell so DevBridge can establish its approved system prerequisite.',
    });
  }

  try {
    await install(invoke, fetchImpl, environment, approved);
  } catch (error) {
    return record({
      ready: false,
      blocker: `Windows signature-verification prerequisite establishment failed: ${error.message}. Resolve the reported network, policy, or installer boundary and re-run devbridge setup.`,
    });
  }

  let verified;
  try {
    verified = await inspect(invoke, environment);
  } catch (error) {
    return record({
      ready: false,
      changed: true,
      blocker: `${error.message}. The approved package was installed but readiness could not be re-observed; re-run devbridge setup after repairing PowerShell availability.`,
    });
  }

  if (!verified.executable || !await usableExecutable(invoke, verified.executable, environment)) {
    return record({
      ready: false,
      changed: true,
      blocker: 'The approved Windows signature-verification package was installed, but the verifier is not usable. Re-run devbridge setup after repairing the system installation.',
    });
  }

  return record({ ready: true, changed: true, executable: verified.executable });
}

export { PROTOCOL as WINDOWS_SIGNATURE_VERIFIER_PREREQUISITE_PROTOCOL };