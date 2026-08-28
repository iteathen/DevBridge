import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const WINDOWS_ACCESS_SEED_PROTOCOL = 'devbridge/windows-access-seed-v1';

const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const ACCOUNT_IDENTITY = /^S-1-5-21-(?:\d+-){3}\d+$/u;
const MAX_SEED_BYTES = 128 * 1024;
const DEFAULT_ROOT = path.join(process.env.ProgramData || 'C:\\ProgramData', 'DevBridge', 'access');
const DEFAULT_SEED = path.join(DEFAULT_ROOT, 'seed.json');
const DEFAULT_STATE = path.join(DEFAULT_ROOT, 'state.json');
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

const INSTALL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.DirectoryServices.AccountManagement -ErrorAction Stop
$context = [DirectoryServices.AccountManagement.PrincipalContext]::new([DirectoryServices.AccountManagement.ContextType]::Machine)
try {
  $user = [DirectoryServices.AccountManagement.UserPrincipal]::FindByIdentity($context, [DirectoryServices.AccountManagement.IdentityType]::Name, [string]$data.user)
  if ($null -eq $user) {
    $user = [DirectoryServices.AccountManagement.UserPrincipal]::new($context)
    $user.SamAccountName = [string]$data.user
    $user.Name = [string]$data.user
  }
  $user.SetPassword([string]$data.secret)
  $user.Enabled = $true
  $user.PasswordNeverExpires = $true
  $user.UserCannotChangePassword = $false
  $user.Save()

  $standard = [DirectoryServices.AccountManagement.GroupPrincipal]::FindByIdentity($context, [DirectoryServices.AccountManagement.IdentityType]::Sid, 'S-1-5-32-545')
  $remote = [DirectoryServices.AccountManagement.GroupPrincipal]::FindByIdentity($context, [DirectoryServices.AccountManagement.IdentityType]::Sid, 'S-1-5-32-580')
  $elevated = [DirectoryServices.AccountManagement.GroupPrincipal]::FindByIdentity($context, [DirectoryServices.AccountManagement.IdentityType]::Sid, 'S-1-5-32-544')
  if ($null -eq $standard -or $null -eq $remote -or $null -eq $elevated) { throw 'required local access groups are unavailable' }
  if (-not $standard.Members.Contains($user)) { $standard.Members.Add($user); $standard.Save() }
  if (-not $remote.Members.Contains($user)) { $remote.Members.Add($user); $remote.Save() }
  if ($elevated.Members.Contains($user)) { $elevated.Members.Remove($user); $elevated.Save() }

  $user = [DirectoryServices.AccountManagement.UserPrincipal]::FindByIdentity($context, [DirectoryServices.AccountManagement.IdentityType]::Name, [string]$data.user)
  if ($null -eq $user -or -not $user.Enabled) { throw 'runtime account did not become enabled' }
  if (-not $standard.Members.Contains($user) -or -not $remote.Members.Contains($user)) { throw 'standard runtime access was not established' }
  if ($elevated.Members.Contains($user)) { throw 'Administrators membership was not removed' }
  @{ target = [string]$data.target; accountIdentity = [string]$user.Sid.Value; standardAccess = $true } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $context) { $context.Dispose() }
}
`;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

export function normalizeWindowsAccessSeed(raw) {
  const value = requireObject(raw, 'Windows access seed');
  onlyKeys(value, new Set(['protocol', 'target', 'user', 'secret', 'revision']), 'Windows access seed');
  if (value.protocol !== WINDOWS_ACCESS_SEED_PROTOCOL) throw new TypeError('Windows access seed protocol is unsupported');
  if (typeof value.target !== 'string' || !TARGET.test(value.target)) throw new TypeError('Windows access seed target is invalid');
  if (value.user !== 'devbridge') throw new TypeError('Windows access seed user is unsupported');
  if (value.revision !== 1) throw new TypeError('Windows access seed revision is unsupported');
  if (typeof value.secret !== 'string' || value.secret.length < 20 || value.secret.length > 128 || /[\u0000-\u001f\u007f]/u.test(value.secret)
    || !/[A-Z]/u.test(value.secret) || !/[a-z]/u.test(value.secret) || !/[0-9]/u.test(value.secret) || !/[^A-Za-z0-9]/u.test(value.secret)) {
    throw new TypeError('Windows access seed secret is invalid');
  }
  return Object.freeze({ protocol: WINDOWS_ACCESS_SEED_PROTOCOL, target: value.target, user: 'devbridge', secret: value.secret, revision: 1 });
}

function encodedScript(value) { return Buffer.from(value, 'utf16le').toString('base64'); }

function defaultInvoke(request) {
  return new Promise((resolve) => {
    const child = spawn(request.executable, request.arguments, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const append = (current, chunk) => Buffer.concat([current, Buffer.from(chunk)]).subarray(0, request.maxOutputBytes);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.stdin.end(request.input);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ exitCode: null, timedOut: true, aborted: false, outputTruncated: false, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    }, request.timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr: error.message });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: false, aborted: false, outputTruncated: false, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}

export async function installWindowsAccess(raw, { invoke = defaultInvoke } = {}) {
  const seed = normalizeWindowsAccessSeed(raw);
  if (typeof invoke !== 'function') throw new TypeError('Windows access invocation contract is invalid');
  const result = await invoke({
    executable: 'powershell.exe',
    arguments: [...POWERSHELL_ARGS, encodedScript(INSTALL_SCRIPT)],
    input: JSON.stringify(seed),
    timeoutMs: 60_000,
    maxOutputBytes: 256 * 1024,
  });
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) throw new Error('Windows access installation failed');
  let receipt;
  try { receipt = JSON.parse(String(result.stdout ?? '')); } catch { throw new Error('Windows access installation returned invalid structured output'); }
  if (receipt?.target !== seed.target || typeof receipt.accountIdentity !== 'string' || !ACCOUNT_IDENTITY.test(receipt.accountIdentity) || receipt.standardAccess !== true) {
    throw new Error('Windows access installation returned invalid evidence');
  }
  return Object.freeze({ target: seed.target, accountIdentity: receipt.accountIdentity, standardAccess: true });
}

function seedDigest(seed) { return createHash('sha256').update(JSON.stringify(seed), 'utf8').digest('hex'); }

async function loadSeed(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_SEED_BYTES) throw new Error('Windows access seed must be a bounded real file');
  return normalizeWindowsAccessSeed(JSON.parse(await readFile(file, 'utf8')));
}

async function loadState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomic(file, content) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function applyWindowsAccessSeed({ seedFile = DEFAULT_SEED, stateFile = DEFAULT_STATE, install = null, invoke = defaultInvoke } = {}) {
  const seed = await loadSeed(seedFile);
  const digest = seedDigest(seed);
  const current = await loadState(stateFile);
  if (current?.protocol === WINDOWS_ACCESS_SEED_PROTOCOL && current.target === seed.target && current.seedSha256 === digest) {
    await rm(seedFile, { force: true });
    return Object.freeze({ changed: false, target: seed.target });
  }
  const apply = install ?? ((value) => installWindowsAccess(value, { invoke }));
  if (typeof apply !== 'function') throw new TypeError('Windows access installer is invalid');
  const receipt = await apply(seed);
  if (!receipt || receipt.target !== seed.target || typeof receipt.accountIdentity !== 'string' || !ACCOUNT_IDENTITY.test(receipt.accountIdentity) || receipt.standardAccess !== true) {
    throw new Error('Windows access installer returned invalid evidence');
  }
  await atomic(stateFile, `${JSON.stringify({ protocol: WINDOWS_ACCESS_SEED_PROTOCOL, target: seed.target, seedSha256: digest, accountIdentity: receipt.accountIdentity, standardAccess: true, appliedAt: new Date().toISOString() })}\n`);
  await rm(seedFile, { force: true });
  return Object.freeze({ changed: true, target: seed.target });
}

if (process.argv.includes('--once')) {
  await applyWindowsAccessSeed();
} else if (process.argv.includes('--watch')) {
  while (true) {
    try { await applyWindowsAccessSeed(); }
    catch (error) { if (error?.code !== 'ENOENT') process.stderr.write(`Windows access seed apply failed: ${String(error?.message ?? error).slice(0, 2048)}\n`); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
