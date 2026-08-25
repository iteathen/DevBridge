import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { invokeCommand } from '../runtime/command-invocation.js';
import { createConfiguredLifecycleAuthorityClient } from '../runtime/environment-lifecycle-authority-transport.js';
import {
  bindWindowsLifecycleAuthorityRuntime,
  createWindowsLifecycleAuthorityPlan,
} from './windows-lifecycle-authority.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-service-v1';
const OWNERSHIP_PROTOCOL = 'devbridge/windows-lifecycle-authority-ownership-v1';
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const MAX_PACKAGE_FILES = 2_048;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_NODE_BYTES = 256 * 1024 * 1024;
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
]);

export const WINDOWS_LIFECYCLE_AUTHORITY_STATE_PATHS = Object.freeze([
  'environment-foundation/identity.json',
  'environment-foundation/images',
  'environment-foundation/control',
  'environment-foundation/persistent',
  'environment-foundation/image-recovery',
  'environment-foundation/access',
  'environment-foundation/bootstrap',
  'environment-lifecycle',
  'environment-construction',
]);

const INITIALIZE_ROOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$admin = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
function Protect-Directory([string]$target) {
  if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'protected authority root is not a real directory' }
  } else {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
  }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($admin)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagate = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($admin, 'FullControl', $inherit, $propagate, $allow)))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $inherit, $propagate, $allow)))
  Set-Acl -LiteralPath $target -AclObject $acl
}
Protect-Directory ([string]$data.protectedRoot)
Protect-Directory ([string]$data.binDirectory)
Protect-Directory ([string]$data.runtimeDirectory)
@{ ready = $true } | ConvertTo-Json -Compress
`;

const WRITE_MANIFEST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$admin = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$temporary = [string]$data.path + '.tmp'
[IO.File]::WriteAllText($temporary, ([string]$data.content), (New-Object Text.UTF8Encoding($false)))
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($admin)
$allow = [Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($admin, 'FullControl', $allow)))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $allow)))
Set-Acl -LiteralPath $temporary -AclObject $acl
Move-Item -LiteralPath $temporary -Destination ([string]$data.path) -Force
@{ written = $true } | ConvertTo-Json -Compress
`;

const HOST_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$programData = [Environment]::GetFolderPath('CommonApplicationData')
@{
  elevated = [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  operatorSid = [string]$identity.User.Value
  programData = [string]$programData
} | ConvertTo-Json -Compress
`;

const SERVICE_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$service = Get-CimInstance Win32_Service -Filter ("Name='" + ([string]$data.name).Replace("'", "''") + "'") -ErrorAction Stop
if ($null -eq $service) {
  @{ exists = $false } | ConvertTo-Json -Compress
} else {
  @{
    exists = $true
    state = [string]$service.State
    startMode = [string]$service.StartMode
    startName = [string]$service.StartName
    pathName = [string]$service.PathName
    description = [string]$service.Description
  } | ConvertTo-Json -Compress
}
`;

const STOP_SERVICE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$service = Get-Service -Name ([string]$data.name) -ErrorAction SilentlyContinue
if ($null -ne $service -and $service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
  Stop-Service -Name ([string]$data.name) -Force -ErrorAction Stop
  $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
}
@{ stopped = $true } | ConvertTo-Json -Compress
`;

const COMPILE_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (Test-Path -LiteralPath ([string]$data.output)) { Remove-Item -LiteralPath ([string]$data.output) -Force }
Add-Type -LiteralPath ([string]$data.source) -OutputAssembly ([string]$data.output) -OutputType ConsoleApplication -ReferencedAssemblies 'System.ServiceProcess.dll'
if (-not (Test-Path -LiteralPath ([string]$data.output) -PathType Leaf)) { throw 'service host output is missing' }
@{ compiled = $true } | ConvertTo-Json -Compress
`;

const ADD_HYPERV_GROUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$serviceSid = (New-Object Security.Principal.NTAccount([string]$data.serviceAccount)).Translate([Security.Principal.SecurityIdentifier])
$members = @(Get-LocalGroupMember -SID ([string]$data.groupSid) -ErrorAction Stop)
$present = @($members | Where-Object { $_.SID -and $_.SID.Value -eq $serviceSid.Value }).Count -gt 0
if (-not $present) { Add-LocalGroupMember -SID ([string]$data.groupSid) -Member ([string]$data.serviceAccount) -ErrorAction Stop }
@{ changed = (-not $present); serviceSid = [string]$serviceSid.Value } | ConvertTo-Json -Compress
`;

const SEAL_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$admin = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$service = (New-Object Security.Principal.NTAccount([string]$data.serviceAccount)).Translate([Security.Principal.SecurityIdentifier])
$allow = [Security.AccessControl.AccessControlType]::Allow
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagate = [Security.AccessControl.PropagationFlags]::None
function Protected-Acl([string]$target, [string]$serviceRights) {
  $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'protected authority tree contains a reparse point' }
  if ($item.PSIsContainer) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($admin)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($admin, 'FullControl', $inherit, $propagate, $allow)))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $inherit, $propagate, $allow)))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($service, $serviceRights, $inherit, $propagate, $allow)))
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($admin)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($admin, 'FullControl', $allow)))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $allow)))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($service, $serviceRights, $allow)))
  }
  Set-Acl -LiteralPath $target -AclObject $acl
}
$root = [IO.Path]::GetFullPath([string]$data.protectedRoot)
$authority = [IO.Path]::GetFullPath([string]$data.authorityDirectory)
$items = @(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop | Sort-Object { $_.FullName.Length } -Descending)
foreach ($item in $items) {
  $full = [IO.Path]::GetFullPath([string]$item.FullName)
  $insideAuthority = $full.Equals($authority, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($authority.TrimEnd('\\') + '\\', [StringComparison]::OrdinalIgnoreCase)
  Protected-Acl $full $(if ($insideAuthority) { 'Modify' } else { 'ReadAndExecute' })
}
Protected-Acl $root 'ReadAndExecute'

$state = [IO.Path]::GetFullPath([string]$data.stateDirectory)
if (-not (Test-Path -LiteralPath $state -PathType Container)) { New-Item -ItemType Directory -Path $state -Force | Out-Null }
$stateAcl = Get-Acl -LiteralPath $state
$stateAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($service, 'ReadAndExecute', $inherit, $propagate, $allow)))
$stateAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($service, 'CreateFiles, DeleteSubdirectoriesAndFiles, ReadAndExecute', [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, $allow)))
Set-Acl -LiteralPath $state -AclObject $stateAcl

$coordination = [IO.Path]::Combine($state, 'environment-foundation')
if (-not (Test-Path -LiteralPath $coordination -PathType Container)) { New-Item -ItemType Directory -Path $coordination -Force | Out-Null }
$coordAcl = Get-Acl -LiteralPath $coordination
$coordAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($service, 'Modify', $inherit, $propagate, $allow)))
Set-Acl -LiteralPath $coordination -AclObject $coordAcl
@{ sealed = $true; serviceSid = [string]$service.Value } | ConvertTo-Json -Compress
`;

const START_SERVICE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$service = Get-Service -Name ([string]$data.name) -ErrorAction Stop
if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Running) {
  Start-Service -Name ([string]$data.name) -ErrorAction Stop
  $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
}
@{ running = $true } | ConvertTo-Json -Compress
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function boundedReason(value, fallback) {
  const text = String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
  return text.length > 0 ? text.slice(0, 1024) : fallback;
}

function invocationSucceeded(result) {
  return result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true && result?.outputTruncated !== true;
}

async function invokePowerShell(invoke, script, input, operation, environment) {
  let result;
  try {
    result = await invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(script)],
      input: input == null ? null : JSON.stringify(input),
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
      environment,
    });
  } catch (error) {
    throw new Error(`${operation} could not execute: ${boundedReason(error?.message, 'PowerShell is unavailable')}`);
  }
  if (!invocationSucceeded(result)) {
    throw new Error(`${operation} failed: ${boundedReason(result?.stderr || result?.stdout, 'unknown failure')}`);
  }
  try {
    const value = JSON.parse(String(result.stdout ?? '').trim());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid output');
    return value;
  } catch {
    throw new Error(`${operation} returned invalid structured output`);
  }
}

async function inspectWindowsLifecycleAuthorityHost({ invoke, environment }) {
  const value = await invokePowerShell(invoke, HOST_INSPECTION_SCRIPT, null, 'Windows lifecycle authority host inspection', environment);
  if (typeof value.elevated !== 'boolean' || typeof value.operatorSid !== 'string' || typeof value.programData !== 'string') {
    throw new Error('Windows lifecycle authority host inspection returned an invalid record');
  }
  return Object.freeze({ elevated: value.elevated, operatorSid: value.operatorSid, programData: value.programData });
}

function normalizeOwnership(raw, plan) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('protected lifecycle authority ownership record is invalid');
  const allowed = new Set(['protocol', 'authorityIdentity', 'serviceName', 'operatorSid', 'stateMigrationComplete', 'runtime', 'serviceConfigured', 'serviceReady']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error('protected lifecycle authority ownership record is invalid');
  if (raw.protocol !== OWNERSHIP_PROTOCOL || raw.authorityIdentity !== plan.authorityIdentity || raw.serviceName !== plan.service.name) {
    throw new Error('protected lifecycle authority ownership record does not match this installation');
  }
  if (typeof raw.operatorSid !== 'string' || !/^S-1-(?:\d+-)+\d+$/u.test(raw.operatorSid)) throw new Error('protected lifecycle authority ownership operator is invalid');
  if (typeof raw.stateMigrationComplete !== 'boolean' || typeof raw.serviceConfigured !== 'boolean' || typeof raw.serviceReady !== 'boolean') {
    throw new Error('protected lifecycle authority ownership state is invalid');
  }
  if (raw.runtime != null) {
    const runtimeAllowed = new Set(['packageDigest', 'nodeDigest', 'hostSourceDigest', 'hostExecutableDigest']);
    if (!raw.runtime || typeof raw.runtime !== 'object' || Array.isArray(raw.runtime)) throw new Error('protected lifecycle authority runtime record is invalid');
    for (const key of Object.keys(raw.runtime)) if (!runtimeAllowed.has(key)) throw new Error('protected lifecycle authority runtime record is invalid');
    for (const key of runtimeAllowed) if (typeof raw.runtime[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(raw.runtime[key])) throw new Error('protected lifecycle authority runtime digest is invalid');
  }
  return Object.freeze({
    protocol: OWNERSHIP_PROTOCOL,
    authorityIdentity: raw.authorityIdentity,
    serviceName: raw.serviceName,
    operatorSid: raw.operatorSid,
    stateMigrationComplete: raw.stateMigrationComplete,
    runtime: raw.runtime == null ? null : Object.freeze({ ...raw.runtime }),
    serviceConfigured: raw.serviceConfigured,
    serviceReady: raw.serviceReady,
  });
}

async function loadOwnership(plan) {
  try {
    const info = await lstat(plan.ownershipManifest);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 32 * 1024) throw new Error('protected lifecycle authority ownership record is not a bounded real file');
    return normalizeOwnership(JSON.parse(await readFile(plan.ownershipManifest, 'utf8')), plan);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function initialOwnership(plan, operatorSid) {
  return Object.freeze({
    protocol: OWNERSHIP_PROTOCOL,
    authorityIdentity: plan.authorityIdentity,
    serviceName: plan.service.name,
    operatorSid,
    stateMigrationComplete: false,
    runtime: null,
    serviceConfigured: false,
    serviceReady: false,
  });
}

async function writeOwnership(plan, ownership, invoke, environment) {
  const normalized = normalizeOwnership(ownership, plan);
  await invokePowerShell(invoke, WRITE_MANIFEST_SCRIPT, {
    path: plan.ownershipManifest,
    content: `${JSON.stringify(normalized)}\n`,
  }, 'Windows lifecycle authority ownership checkpoint', environment);
  return normalized;
}

async function initializeProtectedRoot(plan, operatorSid, invoke, environment) {
  let existing = null;
  try {
    const info = await lstat(plan.protectedRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('protected lifecycle authority root is not a real directory');
    existing = await loadOwnership(plan);
    if (!existing) {
      const names = await readdir(plan.protectedRoot);
      if (names.length > 0) throw new Error('protected lifecycle authority root exists without DevBridge ownership evidence');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing && existing.operatorSid !== operatorSid) {
    throw new Error('protected lifecycle authority operator identity does not match this installation');
  }
  await invokePowerShell(invoke, INITIALIZE_ROOT_SCRIPT, {
    protectedRoot: plan.protectedRoot,
    binDirectory: plan.runtime.binDirectory,
    runtimeDirectory: plan.runtime.runtimeDirectory,
  }, 'Windows lifecycle authority protected-root initialization', environment);
  if (existing) return existing;
  return writeOwnership(plan, initialOwnership(plan, operatorSid), invoke, environment);
}

async function hashFile(file, maxBytes) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) throw new Error(`protected runtime source is not a bounded real file: ${file}`);
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  const after = await lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || bytes !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`protected runtime source changed while being measured: ${file}`);
  }
  return Object.freeze({ size: bytes, digest: hash.digest('hex') });
}

async function packageSnapshot(root) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('DevBridge package source must be a real directory');
  const files = [];
  const visit = async (relativeDirectory) => {
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      const absolute = path.join(root, relative);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`DevBridge package source contains filesystem indirection: ${relative}`);
      if (info.isDirectory()) await visit(relative);
      else if (info.isFile()) {
        if (info.size > MAX_PACKAGE_FILE_BYTES) throw new Error(`DevBridge package source file exceeds the protected runtime bound: ${relative}`);
        files.push(relative);
        if (files.length > MAX_PACKAGE_FILES) throw new Error('DevBridge package source exceeds the protected runtime file-count bound');
      } else throw new Error(`DevBridge package source contains an unsupported entry: ${relative}`);
    }
  };
  const packageFile = path.join(root, 'package.json');
  await hashFile(packageFile, MAX_PACKAGE_FILE_BYTES);
  files.push('package.json');
  await visit('src');
  files.sort((left, right) => left.localeCompare(right));
  const manifest = [];
  let total = 0;
  for (const relative of files) {
    const measured = await hashFile(path.join(root, relative), MAX_PACKAGE_FILE_BYTES);
    total += measured.size;
    if (total > MAX_PACKAGE_BYTES) throw new Error('DevBridge package source exceeds the protected runtime byte bound');
    manifest.push(Object.freeze({ relative: relative.replaceAll(path.sep, '/'), size: measured.size, digest: measured.digest }));
  }
  const digest = createHash('sha256');
  for (const entry of manifest) digest.update(`${entry.relative}\0${entry.size}\0${entry.digest}\n`, 'utf8');
  return Object.freeze({ digest: digest.digest('hex'), files: Object.freeze(manifest) });
}

export async function measureWindowsLifecycleAuthorityCandidate({ packageRoot, nodeExecutable } = {}) {
  if (typeof packageRoot !== 'string' || packageRoot.length === 0 || typeof nodeExecutable !== 'string' || nodeExecutable.length === 0) {
    throw new TypeError('Windows lifecycle authority runtime candidate paths are required');
  }
  const [sourceSnapshot, node] = await Promise.all([
    packageSnapshot(packageRoot),
    hashFile(nodeExecutable, MAX_NODE_BYTES),
  ]);
  return Object.freeze({
    sourceSnapshot,
    node,
    evidence: Object.freeze({ packageDigest: sourceSnapshot.digest, nodeDigest: node.digest }),
  });
}

async function copyPackageSnapshot(snapshot, sourceRoot, destinationRoot) {
  const staging = `${destinationRoot}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const entry of snapshot.files) {
    const source = path.join(sourceRoot, ...entry.relative.split('/'));
    const destination = path.join(staging, ...entry.relative.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const measured = await hashFile(destination, MAX_PACKAGE_FILE_BYTES);
    if (measured.size !== entry.size || measured.digest !== entry.digest) throw new Error(`protected package copy verification failed: ${entry.relative}`);
  }
  const staged = await packageSnapshot(staging);
  if (staged.digest !== snapshot.digest) throw new Error('protected package copy aggregate verification failed');
  await rm(destinationRoot, { recursive: true, force: true });
  await rename(staging, destinationRoot);
}

async function copyBoundedFile(source, destination, limit) {
  const expected = await hashFile(source, limit);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const observed = await hashFile(destination, limit);
  if (expected.size !== observed.size || expected.digest !== observed.digest) throw new Error(`protected runtime copy verification failed: ${path.basename(destination)}`);
  return observed.digest;
}

async function copyAuthorityEntry(source, destination) {
  let info;
  try { info = await lstat(source); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink()) throw new Error(`authority state contains filesystem indirection: ${source}`);
  if (info.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return;
  }
  if (!info.isDirectory()) throw new Error(`authority state contains an unsupported entry: ${source}`);
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) await copyAuthorityEntry(path.join(source, entry.name), path.join(destination, entry.name));
}

export async function migrateWindowsLifecycleAuthorityState({ stateDirectory, authorityDirectory } = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || typeof authorityDirectory !== 'string' || authorityDirectory.length === 0) {
    throw new TypeError('Windows lifecycle authority migration directories are required');
  }
  const staging = `${authorityDirectory}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const relative of WINDOWS_LIFECYCLE_AUTHORITY_STATE_PATHS) {
    const parts = relative.split('/');
    await copyAuthorityEntry(path.join(stateDirectory, ...parts), path.join(staging, ...parts));
  }
  await rm(authorityDirectory, { recursive: true, force: true });
  await rename(staging, authorityDirectory);
  return Object.freeze({ migrated: true, paths: WINDOWS_LIFECYCLE_AUTHORITY_STATE_PATHS });
}

async function inspectService(plan, invoke, environment) {
  const value = await invokePowerShell(invoke, SERVICE_INSPECTION_SCRIPT, { name: plan.service.name }, 'Windows lifecycle authority service inspection', environment);
  if (value.exists === false) return Object.freeze({ exists: false });
  if (value.exists !== true || typeof value.state !== 'string' || typeof value.startName !== 'string' || typeof value.pathName !== 'string') {
    throw new Error('Windows lifecycle authority service inspection returned an invalid record');
  }
  return Object.freeze({
    exists: true,
    state: value.state,
    startMode: String(value.startMode ?? ''),
    startName: value.startName,
    pathName: value.pathName,
    description: String(value.description ?? ''),
  });
}

function sameWindowsText(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function validateOwnedService(service, plan) {
  if (!service.exists) return;
  if (!sameWindowsText(service.startName, plan.service.account) || !sameWindowsText(service.pathName, plan.serviceCommand)) {
    throw new Error('existing Windows lifecycle authority service does not match protected DevBridge ownership');
  }
}

async function invokeSc(invoke, args, operation, environment) {
  let result;
  try {
    result = await invoke({
      executable: 'sc.exe', arguments: args, input: null, timeoutMs: 30_000, maxOutputBytes: 128 * 1024, environment,
    });
  } catch (error) {
    throw new Error(`${operation} could not execute: ${boundedReason(error?.message, 'sc.exe is unavailable')}`);
  }
  if (!invocationSucceeded(result)) throw new Error(`${operation} failed: ${boundedReason(result?.stderr || result?.stdout, 'unknown failure')}`);
}

async function quiesceOwnedService(service, plan, invoke, environment) {
  if (!service.exists) return;
  await invokeSc(invoke, ['config', plan.service.name, 'start=', 'demand'], 'Windows lifecycle authority service update fencing', environment);
  await invokePowerShell(invoke, STOP_SERVICE_SCRIPT, { name: plan.service.name }, 'Windows lifecycle authority service stop', environment);
}

async function configureService(service, plan, invoke, environment) {
  const command = plan.serviceCommand;
  let changed = false;
  if (!service.exists) {
    await invokeSc(invoke, [
      'create', plan.service.name,
      'binPath=', command,
      'start=', 'demand',
      'obj=', plan.service.account,
      'DisplayName=', plan.service.displayName,
    ], 'Windows lifecycle authority service creation', environment);
    changed = true;
  }
  await invokeSc(invoke, ['config', plan.service.name, 'binPath=', command, 'start=', 'auto', 'obj=', plan.service.account], 'Windows lifecycle authority service configuration', environment);
  await invokeSc(invoke, ['sidtype', plan.service.name, plan.service.sidType], 'Windows lifecycle authority service SID configuration', environment);
  await invokeSc(invoke, ['failure', plan.service.name, 'reset=', '86400', 'actions=', 'restart/5000'], 'Windows lifecycle authority service failure policy', environment);
  await invokeSc(invoke, ['description', plan.service.name, plan.service.description], 'Windows lifecycle authority runtime evidence configuration', environment);
  const group = await invokePowerShell(invoke, ADD_HYPERV_GROUP_SCRIPT, {
    serviceAccount: plan.service.account,
    groupSid: plan.service.hyperVGroupSid,
  }, 'Windows lifecycle authority Hyper-V group admission', environment);
  changed ||= group.changed === true;
  return Object.freeze({ changed });
}

async function protectedRuntimeCurrent(plan, ownership, sourceSnapshot, nodeDigest) {
  if (!ownership.runtime || ownership.runtime.packageDigest !== sourceSnapshot.digest || ownership.runtime.nodeDigest !== nodeDigest) return false;
  try {
    const [packageObserved, nodeObserved, hostSourceObserved, hostExecutableObserved] = await Promise.all([
      packageSnapshot(plan.runtime.packageDirectory),
      hashFile(plan.runtime.nodeExecutable, MAX_NODE_BYTES),
      hashFile(plan.runtime.serviceHostSource, MAX_PACKAGE_FILE_BYTES),
      hashFile(plan.runtime.serviceHostExecutable, MAX_NODE_BYTES),
    ]);
    return packageObserved.digest === ownership.runtime.packageDigest
      && nodeObserved.digest === ownership.runtime.nodeDigest
      && hostSourceObserved.digest === ownership.runtime.hostSourceDigest
      && hostExecutableObserved.digest === ownership.runtime.hostExecutableDigest;
  } catch {
    return false;
  }
}

async function materializeProtectedRuntime(plan, ownership, invoke, environment, { packageRoot, nodeExecutable, candidate }) {
  const sourceSnapshot = candidate?.sourceSnapshot ?? await packageSnapshot(packageRoot);
  const node = candidate?.node ?? await hashFile(nodeExecutable, MAX_NODE_BYTES);
  if (await protectedRuntimeCurrent(plan, ownership, sourceSnapshot, node.digest)) return Object.freeze({ ownership, changed: false });

  await copyPackageSnapshot(sourceSnapshot, packageRoot, plan.runtime.packageDirectory);
  const nodeDigest = await copyBoundedFile(nodeExecutable, plan.runtime.nodeExecutable, MAX_NODE_BYTES);
  const hostSource = path.join(packageRoot, 'src', 'setup', 'windows-lifecycle-authority-host.cs');
  const hostSourceDigest = await copyBoundedFile(hostSource, plan.runtime.serviceHostSource, MAX_PACKAGE_FILE_BYTES);
  await invokePowerShell(invoke, COMPILE_HOST_SCRIPT, {
    source: plan.runtime.serviceHostSource,
    output: plan.runtime.serviceHostExecutable,
  }, 'Windows lifecycle authority host compilation', environment);
  const hostExecutable = await hashFile(plan.runtime.serviceHostExecutable, MAX_NODE_BYTES);
  return Object.freeze({
    ownership: Object.freeze({
      ...ownership,
      runtime: Object.freeze({
        packageDigest: sourceSnapshot.digest,
        nodeDigest,
        hostSourceDigest,
        hostExecutableDigest: hostExecutable.digest,
      }),
      serviceReady: false,
    }),
    changed: true,
  });
}

async function provisionWindowsLifecycleAuthority({ plan, operatorSid, invoke, environment, packageRoot, nodeExecutable, candidate }) {
  let ownership = await initializeProtectedRoot(plan, operatorSid, invoke, environment);
  const initialProtectionSeal = ownership.serviceConfigured !== true;
  const service = await inspectService(plan, invoke, environment);
  validateOwnedService(service, plan);
  await quiesceOwnedService(service, plan, invoke, environment);
  let changed = service.exists === true;

  if (!ownership.stateMigrationComplete) {
    await migrateWindowsLifecycleAuthorityState({ stateDirectory: plan.stateDirectory, authorityDirectory: plan.authorityDirectory });
    ownership = await writeOwnership(plan, Object.freeze({ ...ownership, stateMigrationComplete: true, serviceReady: false }), invoke, environment);
    changed = true;
  }

  const runtime = await materializeProtectedRuntime(plan, ownership, invoke, environment, { packageRoot, nodeExecutable, candidate });
  ownership = runtime.ownership;
  changed ||= runtime.changed;
  ownership = await writeOwnership(plan, Object.freeze({ ...ownership, operatorSid, serviceReady: false }), invoke, environment);

  const configured = await configureService(service, plan, invoke, environment);
  changed ||= configured.changed;

  if (initialProtectionSeal) {
    await invokePowerShell(invoke, SEAL_ACL_SCRIPT, {
      protectedRoot: plan.protectedRoot,
      authorityDirectory: plan.authorityDirectory,
      stateDirectory: plan.stateDirectory,
      serviceAccount: plan.service.account,
    }, 'Windows lifecycle authority ACL sealing', environment);
  }
  ownership = await writeOwnership(plan, Object.freeze({ ...ownership, serviceConfigured: true }), invoke, environment);
  await invokePowerShell(invoke, START_SERVICE_SCRIPT, { name: plan.service.name }, 'Windows lifecycle authority service start', environment);
  return Object.freeze({ ownership, changed: true });
}

async function stopWindowsLifecycleAuthority(plan, invoke, environment) {
  try {
    await invokePowerShell(invoke, STOP_SERVICE_SCRIPT, { name: plan.service.name }, 'Windows lifecycle authority failed-health stop', environment);
  } catch {
    // The original health failure remains the public blocker. A later elevated setup must reconcile the service state.
  }
}

async function probeWindowsLifecycleAuthority(plan) {
  const client = createConfiguredLifecycleAuthorityClient({ stateDirectory: plan.stateDirectory, platform: 'win32', connectTimeoutMs: 3_000 });
  const result = await client.inspect();
  if (!result || result.protocol !== 'devbridge/environment-operator-v1') throw new Error('protected lifecycle authority returned invalid inspection evidence');
  return result;
}

function serviceResult({ platform, ready, blocker = null, changed = false, authorityIdentity = null, service = null, protectedState = null }) {
  return Object.freeze({ protocol: PROTOCOL, platform, ready, blocker, changed, authorityIdentity, service, protectedState });
}

export async function reconcileWindowsLifecycleAuthorityService({
  stateDirectory,
  platform = process.platform,
  invoke = invokeCommand,
  environment = process.env,
  packageRoot = PACKAGE_ROOT,
  nodeExecutable = process.execPath,
} = {}, {
  inspectHost = inspectWindowsLifecycleAuthorityHost,
  measureCandidate = measureWindowsLifecycleAuthorityCandidate,
  probe = probeWindowsLifecycleAuthority,
  provision = provisionWindowsLifecycleAuthority,
  stop = stopWindowsLifecycleAuthority,
} = {}) {
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('Windows lifecycle authority setup platform is invalid');
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('Windows lifecycle authority setup stateDirectory is required');
  if (typeof invoke !== 'function') throw new TypeError('Windows lifecycle authority setup invocation contract is invalid');
  if (typeof measureCandidate !== 'function') throw new TypeError('Windows lifecycle authority runtime measurement contract is invalid');
  if (platform !== 'win32') return serviceResult({ platform, ready: true, service: 'not-applicable', protectedState: 'not-applicable' });

  let host;
  try { host = await inspectHost({ invoke, environment }); }
  catch (error) {
    return serviceResult({ platform, ready: false, blocker: `Windows lifecycle authority host inspection failed: ${boundedReason(error?.message, 'unknown failure')}`, service: 'unavailable', protectedState: 'unknown' });
  }

  let candidate;
  try {
    candidate = await measureCandidate({ packageRoot, nodeExecutable });
  } catch {
    return serviceResult({
      platform,
      ready: false,
      blocker: 'Windows lifecycle authority runtime candidate could not be verified from the exact local package and Node executable.',
      service: 'unavailable',
      protectedState: 'unknown',
    });
  }

  let plan;
  try {
    const basePlan = createWindowsLifecycleAuthorityPlan({ stateDirectory, programDataDirectory: host.programData, operatorSid: host.operatorSid });
    plan = bindWindowsLifecycleAuthorityRuntime(basePlan, candidate.evidence);
  } catch (error) {
    return serviceResult({ platform, ready: false, blocker: `Windows lifecycle authority plan is invalid: ${boundedReason(error?.message, 'unknown failure')}`, service: 'unavailable', protectedState: 'unknown' });
  }

  try {
    await probe(plan);
    return serviceResult({ platform, ready: true, authorityIdentity: plan.authorityIdentity, service: 'ready', protectedState: 'ready' });
  } catch {
    // Missing, stale, or unhealthy authority is a setup concern below; ordinary callers still get a bounded elevation boundary.
  }

  if (host.elevated !== true) {
    return serviceResult({
      platform,
      ready: false,
      authorityIdentity: plan.authorityIdentity,
      service: 'unavailable',
      protectedState: 'unknown',
      blocker: 'Windows protected lifecycle authority is not ready. Re-run devbridge setup from an elevated PowerShell so DevBridge can establish the protected service and state boundary.',
    });
  }

  let provisioned;
  try {
    provisioned = await provision({ plan, operatorSid: host.operatorSid, invoke, environment, packageRoot, nodeExecutable, candidate });
  } catch (error) {
    return serviceResult({
      platform,
      ready: false,
      authorityIdentity: plan.authorityIdentity,
      service: 'blocked',
      protectedState: 'blocked',
      blocker: `Windows protected lifecycle authority provisioning failed: ${boundedReason(error?.message, 'unknown failure')}`,
    });
  }

  try {
    await probe(plan);
  } catch (error) {
    await stop(plan, invoke, environment);
    return serviceResult({
      platform,
      ready: false,
      changed: provisioned?.changed === true,
      authorityIdentity: plan.authorityIdentity,
      service: 'stopped-after-failed-health',
      protectedState: provisioned?.ownership?.stateMigrationComplete === true ? 'ready' : 'blocked',
      blocker: `Windows protected lifecycle authority failed its post-start health proof: ${boundedReason(error?.message, 'authority unavailable')}`,
    });
  }

  try {
    if (provisioned?.ownership) {
      await writeOwnership(plan, Object.freeze({ ...provisioned.ownership, serviceReady: true }), invoke, environment);
    }
  } catch (error) {
    await stop(plan, invoke, environment);
    return serviceResult({
      platform,
      ready: false,
      changed: true,
      authorityIdentity: plan.authorityIdentity,
      service: 'stopped-after-checkpoint-failure',
      protectedState: 'ready',
      blocker: `Windows protected lifecycle authority could not checkpoint healthy ownership: ${boundedReason(error?.message, 'checkpoint failure')}`,
    });
  }

  return serviceResult({
    platform,
    ready: true,
    changed: provisioned?.changed === true,
    authorityIdentity: plan.authorityIdentity,
    service: 'ready',
    protectedState: 'ready',
  });
}

export {
  OWNERSHIP_PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
  PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_SERVICE_PROTOCOL,
};
