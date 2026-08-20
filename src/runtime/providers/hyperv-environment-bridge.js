import { lstat, realpath } from 'node:fs/promises';

const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const MAX_RESPONSE_BYTES = 7 * 1024 * 1024;
const MAX_FRAME_BYTES = 44 * 1024;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function bounded(value, name, maxBytes = 8_192) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is invalid`);
  return value;
}

function encodeScript(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

function normalizeTarget(value) {
  if (typeof value !== 'string' || !TARGET.test(value)) throw new TypeError('bridge target is invalid');
  return value;
}

function normalizeLocation(raw) {
  const value = requireObject(raw, 'bridge location');
  onlyKeys(value, new Set(['reference', 'proof']), 'bridge location');
  if (typeof value.reference !== 'string' || !REFERENCE.test(value.reference)) throw new TypeError('bridge location.reference is invalid');
  return {
    reference: value.reference,
    proof: bounded(value.proof, 'bridge location.proof', 2_048),
  };
}

async function regularFile(value, name) {
  const lexical = bounded(value, name, 4_096);
  const info = await lstat(lexical);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a real regular file`);
  return realpath(lexical);
}

function normalizeAccess(raw) {
  const value = requireObject(raw, 'bridge access');
  if (value.family === 'windows') {
    onlyKeys(value, new Set(['family', 'username', 'password']), 'bridge access');
    return {
      family: 'windows',
      username: bounded(value.username, 'bridge access.username', 512),
      password: bounded(value.password, 'bridge access.password', 16_384),
    };
  }
  if (value.family === 'linux') {
    onlyKeys(value, new Set(['family', 'user', 'address', 'identityFile', 'knownHostsFile']), 'bridge access');
    if (typeof value.user !== 'string' || !USER.test(value.user)) throw new TypeError('bridge access.user is invalid');
    if (typeof value.address !== 'string' || !ADDRESS.test(value.address)) throw new TypeError('bridge access.address is invalid');
    return { family: 'linux', user: value.user, address: value.address, identityFile: value.identityFile, knownHostsFile: value.knownHostsFile };
  }
  throw new TypeError('bridge access.family is invalid');
}

function parseInvocation(result, name) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    const detail = String(result?.stderr || result?.stdout || `${name} failed`).trim().slice(0, 2_048);
    throw new Error(detail || `${name} failed`);
  }
  const text = String(result.stdout ?? '').trim();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error(`${name} returned invalid bounded output`);
  return text;
}

const VERIFY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.reference) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.proof) { throw 'environment ownership proof does not match' }
if ([string]$item.State -ne 'Running') { throw 'environment is not running' }
@{ ready = $true } | ConvertTo-Json -Compress
`;

const DIRECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.reference) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.proof) { throw 'environment ownership proof does not match' }
if ([string]$item.State -ne 'Running') { throw 'environment is not running' }
$secure = ConvertTo-SecureString ([string]$data.password) -AsPlainText -Force
$credential = [Management.Automation.PSCredential]::new([string]$data.username, $secure)
$session = New-PSSession -VMName ([string]$data.reference) -Credential $credential -ErrorAction Stop
try {
  $output = Invoke-Command -Session $session -ArgumentList ([string]$data.frame), ([string]$data.target) -ScriptBlock {
    param($encoded, $target)
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = 'node.exe'
    $start.Arguments = 'C:\ProgramData\DevBridge\bridge-agent.mjs --exchange-stdin'
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables['DEVBRIDGE_GUEST_TARGET'] = $target
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'bridge helper did not start' }
    $process.StandardInput.Write($json)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw ('bridge helper failed: ' + $stderr) }
    $stdout
  } -ErrorAction Stop
  [string]$output
} finally {
  if ($null -ne $session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
}
`;

export class HyperVEnvironmentBridge {
  #invoke;
  #access;
  #locate;

  constructor({ invoke, access, locate }) {
    if (typeof invoke !== 'function') throw new TypeError('bridge invoke must be a function');
    if (typeof access !== 'function') throw new TypeError('bridge access must be a function');
    if (typeof locate !== 'function') throw new TypeError('bridge locate must be a function');
    this.#invoke = invoke;
    this.#access = access;
    this.#locate = locate;
  }

  async #powerShell(script, payload, { signal = null, timeoutMs = 90_000 } = {}) {
    return parseInvocation(await this.#invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodeScript(script)],
      input: JSON.stringify(payload),
      timeoutMs,
      maxOutputBytes: MAX_RESPONSE_BYTES,
      signal,
    }), 'bridge management operation');
  }

  async #location(target) {
    return normalizeLocation(await this.#locate(target));
  }

  async #verify(target, { signal = null } = {}) {
    const location = await this.#location(target);
    const text = await this.#powerShell(VERIFY_SCRIPT, location, { signal, timeoutMs: 45_000 });
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('bridge management verification returned invalid structured output'); }
    if (parsed?.ready !== true) throw new Error('bridge management verification did not prove readiness');
    return location;
  }

  async exchange(frame, { signal = null } = {}) {
    const target = normalizeTarget(frame?.target);
    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FRAME_BYTES) throw new Error('bridge frame exceeds this attachment limit');
    const selected = normalizeAccess(await this.#access(target));

    if (selected.family === 'windows') {
      const location = await this.#location(target);
      const text = await this.#powerShell(DIRECT_SCRIPT, {
        ...location,
        username: selected.username,
        password: selected.password,
        target,
        frame: Buffer.from(serialized, 'utf8').toString('base64'),
      }, { signal, timeoutMs: 120_000 });
      try { return JSON.parse(text); } catch { throw new Error('bridge helper returned invalid structured output'); }
    }

    await this.#verify(target, { signal });
    const [identityFile, knownHostsFile] = await Promise.all([
      regularFile(selected.identityFile, 'bridge access.identityFile'),
      regularFile(selected.knownHostsFile, 'bridge access.knownHostsFile'),
    ]);
    const destination = `${selected.user}@${selected.address}`;
    const result = await this.#invoke({
      executable: 'ssh.exe',
      arguments: [
        '-F', 'NUL', '-T',
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${knownHostsFile}`, '-o', 'GlobalKnownHostsFile=NUL',
        '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no',
        '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
        '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
        '-i', identityFile, destination, 'node', '/usr/local/libexec/devbridge/bridge-agent.mjs', '--exchange-stdin',
      ],
      input: serialized,
      timeoutMs: 120_000,
      maxOutputBytes: MAX_RESPONSE_BYTES,
      signal,
    });
    const text = parseInvocation(result, 'bridge guest operation');
    try { return JSON.parse(text); } catch { throw new Error('bridge helper returned invalid structured output'); }
  }
}
