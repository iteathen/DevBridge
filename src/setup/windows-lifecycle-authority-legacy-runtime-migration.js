import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import { createConfiguredLifecycleAuthorityClient } from '../runtime/environment-lifecycle-authority-transport.js';
import {
  bindWindowsLifecycleAuthorityRuntime,
  createWindowsLifecycleAuthorityPlan,
  WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_LEGACY_V1,
  WINDOWS_LOCAL_SYSTEM_ACCOUNT,
  windowsLifecycleAuthorityRuntimeGeneration,
} from './windows-lifecycle-authority.js';
import {
  measureWindowsLifecycleAuthorityCandidate,
  WINDOWS_LIFECYCLE_AUTHORITY_GENERATION_PROTOCOL,
  WINDOWS_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
} from './windows-lifecycle-authority-service.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-legacy-runtime-migration-v1';
const JOURNAL_PROTOCOL = 'devbridge/windows-lifecycle-authority-legacy-runtime-journal-v1';
const JOURNAL_FILE = 'legacy-runtime-migration.json';
const MAX_CONTROL_BYTES = 32 * 1024;
const MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_NODE_BYTES = 256 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/u;
const SID = /^S-1-(?:\d+-)+\d+$/u;
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
]);
const EFFECTS = new Set(['stage', 'quiesce', 'promote', 'start', 'restore']);
const EFFECT_STATES = new Set(['planned', 'attempted']);
const PHASES = new Set(['observed', 'staged', 'quiesced', 'promoted', 'started', 'restored', 'complete']);
const DIAGNOSTIC_PROTOCOL = 'devbridge/windows-lifecycle-authority-migration-diagnostic-v1';
const HEALTH_PROBE_DEADLINE_MS = 15_000;
const HEALTH_PROBE_ATTEMPT_MS = 1_000;
const HEALTH_PROBE_RETRY_MS = 250;

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
    startName = [string]$service.StartName
    pathName = [string]$service.PathName
    description = [string]$service.Description
  } | ConvertTo-Json -Compress
}
`;

const STOP_SERVICE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$service = Get-Service -Name ([string]$data.name) -ErrorAction Stop
if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
  Stop-Service -Name ([string]$data.name) -Force -ErrorAction Stop
  $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
}
@{ stopped = $true } | ConvertTo-Json -Compress
`;

const START_SERVICE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$name = [string]$data.name
try {
  $service = Get-Service -Name $name -ErrorAction Stop
  if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Running) {
    Start-Service -Name $name -ErrorAction Stop
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
  }
  @{ running = $true } | ConvertTo-Json -Compress
} catch {
  $failure = [string]$_.Exception.Message
  $observed = Get-CimInstance Win32_Service -Filter ("Name='" + $name.Replace("'", "''") + "'") -ErrorAction SilentlyContinue
  $events = @()
  try {
    $events = @(Get-WinEvent -FilterHashtable @{
      LogName = 'System'
      ProviderName = 'Service Control Manager'
      StartTime = (Get-Date).AddMinutes(-2)
    } -ErrorAction Stop | Where-Object { $_.Message -like ("*" + $name + "*") } | Select-Object -First 4 | ForEach-Object {
      @{
        id = [int]$_.Id
        level = [string]$_.LevelDisplayName
        message = (([string]$_.Message -replace '[\r\n]+', ' ').Trim())
      }
    })
  } catch {}
  @{
    running = $false
    error = (($failure -replace '[\r\n]+', ' ').Trim())
    state = if ($null -eq $observed) { $null } else { [string]$observed.State }
    status = if ($null -eq $observed) { $null } else { [string]$observed.Status }
    exitCode = if ($null -eq $observed) { $null } else { [int]$observed.ExitCode }
    serviceSpecificExitCode = if ($null -eq $observed) { $null } else { [int]$observed.ServiceSpecificExitCode }
    processId = if ($null -eq $observed) { $null } else { [int]$observed.ProcessId }
    events = $events
  } | ConvertTo-Json -Compress -Depth 5
  exit 3
}
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function invocationSucceeded(result) {
  return result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true && result?.outputTruncated !== true;
}

function boundedReason(value, fallback) {
  const text = String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
  return text.length > 0 ? text.slice(0, 512) : fallback;
}

async function invokePowerShell(invoke, script, input, operation, environment) {
  let result;
  try {
    result = await invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(script)],
      input: input == null ? null : JSON.stringify(input),
      timeoutMs: 120_000,
      maxOutputBytes: 128 * 1024,
      environment,
    });
  } catch (error) {
    throw new Error(`${operation} could not execute: ${boundedReason(error?.message, 'PowerShell is unavailable')}`);
  }
  if (!invocationSucceeded(result)) {
    const evidence = boundedReason(result?.stdout || result?.stderr, 'no bounded process evidence');
    throw new Error(`${operation} failed: exit=${result?.exitCode ?? 'unknown'} timeout=${result?.timedOut === true} aborted=${result?.aborted === true} evidence=${evidence}`);
  }
  let value;
  try { value = JSON.parse(String(result.stdout ?? '').trim()); }
  catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${operation} returned invalid structured output`);
  return value;
}

async function inspectHost({ invoke, environment }) {
  const value = await invokePowerShell(invoke, HOST_INSPECTION_SCRIPT, null, 'Windows lifecycle authority legacy host inspection', environment);
  if (typeof value.elevated !== 'boolean' || !SID.test(String(value.operatorSid ?? '')) || typeof value.programData !== 'string') {
    throw new Error('Windows lifecycle authority legacy host inspection returned invalid evidence');
  }
  return Object.freeze({ elevated: value.elevated, operatorSid: value.operatorSid, programData: value.programData });
}

async function inspectService(plan, invoke, environment) {
  const value = await invokePowerShell(invoke, SERVICE_INSPECTION_SCRIPT, { name: plan.service.name }, 'Windows lifecycle authority legacy service inspection', environment);
  if (value.exists === false) return Object.freeze({ exists: false });
  if (value.exists !== true || typeof value.state !== 'string' || typeof value.startName !== 'string' || typeof value.pathName !== 'string') {
    throw new Error('Windows lifecycle authority legacy service inspection returned invalid evidence');
  }
  return Object.freeze({
    exists: true,
    state: value.state,
    startName: value.startName,
    pathName: value.pathName,
    description: String(value.description ?? ''),
  });
}

async function invokeSc(invoke, args, operation, environment) {
  let result;
  try {
    result = await invoke({
      executable: 'sc.exe',
      arguments: args,
      input: null,
      timeoutMs: 30_000,
      maxOutputBytes: 128 * 1024,
      environment,
    });
  } catch (error) {
    throw new Error(`${operation} could not execute: ${boundedReason(error?.message, 'sc.exe is unavailable')}`);
  }
  if (!invocationSucceeded(result)) {
    const evidence = boundedReason(result?.stdout || result?.stderr, 'no bounded process evidence');
    throw new Error(`${operation} failed: exit=${result?.exitCode ?? 'unknown'} timeout=${result?.timedOut === true} aborted=${result?.aborted === true} evidence=${evidence}`);
  }
}

function exactDigest(value, name) {
  const selected = String(value ?? '').toLowerCase();
  if (!DIGEST.test(selected)) throw new Error(`${name} is invalid`);
  return selected;
}

function quoteServiceArgument(value) {
  const text = String(value);
  if (text.includes('"') || text.includes('\0')) throw new Error('Windows lifecycle authority legacy service argument is invalid');
  return `"${text}"`;
}

function serviceCommand(fields) {
  return fields.map(quoteServiceArgument).join(' ');
}

function fixedRuntimePlan(basePlan, runtimeEvidence) {
  const root = basePlan.protectedRoot;
  const runtimeDirectory = path.win32.join(root, 'runtime');
  const packageDirectory = path.win32.join(runtimeDirectory, 'package');
  const binDirectory = path.win32.join(root, 'bin');
  const serviceHostExecutable = path.win32.join(binDirectory, 'devbridge-lifecycle-authority-host.exe');
  const nodeExecutable = path.win32.join(binDirectory, 'node.exe');
  const workerEntry = path.win32.join(packageDirectory, 'src', 'entry', 'windows-lifecycle-authority-worker.mjs');
  const serviceHostSource = path.win32.join(runtimeDirectory, 'windows-lifecycle-authority-host.cs');
  const description = `DevBridge lifecycle authority runtime v1 package=${runtimeEvidence.packageDigest} node=${runtimeEvidence.nodeDigest}`;
  return Object.freeze({
    packageDirectory,
    nodeExecutable,
    serviceHostSource,
    serviceHostExecutable,
    serviceCommand: serviceCommand([
      serviceHostExecutable,
      '--service-name', basePlan.service.name,
      '--protected-root', basePlan.protectedRoot,
      '--node', nodeExecutable,
      '--worker', workerEntry,
      '--state-directory', basePlan.stateDirectory,
      '--authority-directory', basePlan.authorityDirectory,
      '--operator-sid', basePlan.operatorSid,
      '--read-pipe', basePlan.endpoints.read.pipeName,
      '--mutation-pipe', basePlan.endpoints.mutation.pipeName,
    ]),
    service: Object.freeze({ ...basePlan.service, description }),
  });
}

function sameWindowsText(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function running(service) {
  return service.exists === true && sameWindowsText(service.state, 'Running');
}

function serviceMatches(service, command, servicePlan, {
  allowMissingDescription = false,
  allowRetiredVirtualLogon = false,
} = {}) {
  const description = String(service.description ?? '');
  const logonMatches = sameWindowsText(service.startName, servicePlan.logonAccount)
    || (allowRetiredVirtualLogon
      && servicePlan.logonAccount === WINDOWS_LOCAL_SYSTEM_ACCOUNT
      && sameWindowsText(service.startName, servicePlan.account));
  return service.exists === true
    && logonMatches
    && sameWindowsText(service.pathName, command)
    && (description === servicePlan.description || (allowMissingDescription && description === ''));
}

async function boundedRealDirectory(directory, name) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} is not a real directory`);
}

async function boundedFileDigest(file, maxBytes) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) throw new Error('legacy protected runtime contains an invalid file');
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  const after = await lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes !== before.size) {
    throw new Error('legacy protected runtime changed while being measured');
  }
  return Object.freeze({ size: bytes, digest: hash.digest('hex') });
}

async function readBoundedJson(file, limit, name) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > limit) throw new Error(`${name} is invalid`);
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error(`${name} is invalid`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is invalid`);
  return value;
}

function normalizeOwnership(raw, basePlan, operatorSid) {
  const allowed = new Set(['protocol', 'authorityIdentity', 'serviceName', 'operatorSid', 'stateMigrationComplete', 'runtime', 'serviceConfigured', 'serviceReady']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error('legacy protected runtime ownership contains an unknown field');
  if (raw.protocol !== WINDOWS_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL
      || raw.authorityIdentity !== basePlan.authorityIdentity
      || raw.serviceName !== basePlan.service.name
      || raw.operatorSid !== operatorSid
      || raw.stateMigrationComplete !== true
      || raw.serviceConfigured !== true
      || raw.serviceReady !== true) {
    throw new Error('legacy protected runtime ownership is incomplete or inconsistent');
  }
  if (!raw.runtime || typeof raw.runtime !== 'object' || Array.isArray(raw.runtime)) throw new Error('legacy protected runtime evidence is missing');
  const runtimeAllowed = new Set(['packageDigest', 'nodeDigest', 'hostSourceDigest', 'hostExecutableDigest']);
  for (const key of Object.keys(raw.runtime)) if (!runtimeAllowed.has(key)) throw new Error('legacy protected runtime evidence contains an unknown field');
  const runtime = Object.freeze({
    packageDigest: exactDigest(raw.runtime.packageDigest, 'legacy package digest'),
    nodeDigest: exactDigest(raw.runtime.nodeDigest, 'legacy Node digest'),
    hostSourceDigest: exactDigest(raw.runtime.hostSourceDigest, 'legacy host source digest'),
    hostExecutableDigest: exactDigest(raw.runtime.hostExecutableDigest, 'legacy host executable digest'),
  });
  return Object.freeze({ ...raw, runtime });
}

function journalPath(basePlan) {
  return path.win32.join(basePlan.protectedRoot, JOURNAL_FILE);
}

function normalizeJournal(raw, basePlan) {
  const allowed = new Set(['protocol', 'authorityIdentity', 'generation', 'phase', 'pending']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error('legacy protected runtime journal contains an unknown field');
  if (raw.protocol !== JOURNAL_PROTOCOL || raw.authorityIdentity !== basePlan.authorityIdentity || !DIGEST.test(String(raw.generation ?? '')) || !PHASES.has(raw.phase)) {
    throw new Error('legacy protected runtime journal is invalid');
  }
  let pending = null;
  if (raw.pending != null) {
    if (!raw.pending || typeof raw.pending !== 'object' || Array.isArray(raw.pending)) throw new Error('legacy protected runtime journal pending effect is invalid');
    const pendingAllowed = new Set(['effect', 'state']);
    for (const key of Object.keys(raw.pending)) if (!pendingAllowed.has(key)) throw new Error('legacy protected runtime journal pending effect contains an unknown field');
    if (!EFFECTS.has(raw.pending.effect) || !EFFECT_STATES.has(raw.pending.state)) throw new Error('legacy protected runtime journal pending effect is invalid');
    pending = Object.freeze({ effect: raw.pending.effect, state: raw.pending.state });
  }
  return Object.freeze({
    protocol: JOURNAL_PROTOCOL,
    authorityIdentity: raw.authorityIdentity,
    generation: raw.generation,
    phase: raw.phase,
    pending,
  });
}

async function loadJournal(basePlan) {
  try { return normalizeJournal(await readBoundedJson(journalPath(basePlan), MAX_CONTROL_BYTES, 'legacy protected runtime journal'), basePlan); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function saveJournal(basePlan, record) {
  const normalized = normalizeJournal(record, basePlan);
  const file = journalPath(basePlan);
  const temporary = `${file}.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, file);
  return normalized;
}

async function exactLegacyEvidence(fixed, ownership, measureCandidate) {
  const candidate = await measureCandidate({ packageRoot: fixed.packageDirectory, nodeExecutable: fixed.nodeExecutable });
  const [hostSource, hostExecutable] = await Promise.all([
    boundedFileDigest(fixed.serviceHostSource, MAX_PACKAGE_FILE_BYTES),
    boundedFileDigest(fixed.serviceHostExecutable, MAX_NODE_BYTES),
  ]);
  if (candidate.evidence.packageDigest !== ownership.runtime.packageDigest
      || candidate.evidence.nodeDigest !== ownership.runtime.nodeDigest
      || hostSource.digest !== ownership.runtime.hostSourceDigest
      || hostExecutable.digest !== ownership.runtime.hostExecutableDigest) {
    throw new Error('legacy protected runtime bytes do not match exact ownership evidence');
  }
  const generation = windowsLifecycleAuthorityRuntimeGeneration(ownership.runtime);
  return Object.freeze({ candidate, hostSource, hostExecutable, generation });
}

async function verifyGenerationDirectory(targetPlan, ownership, measureCandidate, { allowUnversioned = false } = {}) {
  let manifest;
  try { manifest = await readBoundedJson(path.win32.join(targetPlan.runtime.generationDirectory, 'generation.json'), MAX_CONTROL_BYTES, 'legacy generation manifest'); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  const manifestAllowed = new Set(['protocol', 'generation', 'packageDigest', 'nodeDigest', 'hostSourceDigest', 'hostExecutableDigest', 'hostCommandProtocol']);
  for (const key of Object.keys(manifest)) if (!manifestAllowed.has(key)) return false;
  const expectedGeneration = windowsLifecycleAuthorityRuntimeGeneration(ownership.runtime);
  if (manifest.protocol !== WINDOWS_LIFECYCLE_AUTHORITY_GENERATION_PROTOCOL
      || manifest.generation !== expectedGeneration
      || manifest.packageDigest !== ownership.runtime.packageDigest
      || manifest.nodeDigest !== ownership.runtime.nodeDigest
      || manifest.hostSourceDigest !== ownership.runtime.hostSourceDigest
      || manifest.hostExecutableDigest !== ownership.runtime.hostExecutableDigest
      || (manifest.hostCommandProtocol !== WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_LEGACY_V1
        && !(allowUnversioned && manifest.hostCommandProtocol == null))) return false;
  const candidate = await measureCandidate({
    packageRoot: targetPlan.runtime.packageDirectory,
    nodeExecutable: targetPlan.runtime.nodeExecutable,
  });
  const [hostSource, hostExecutable] = await Promise.all([
    boundedFileDigest(targetPlan.runtime.serviceHostSource, MAX_PACKAGE_FILE_BYTES),
    boundedFileDigest(targetPlan.runtime.serviceHostExecutable, MAX_NODE_BYTES),
  ]);
  return candidate.evidence.packageDigest === ownership.runtime.packageDigest
    && candidate.evidence.nodeDigest === ownership.runtime.nodeDigest
    && hostSource.digest === ownership.runtime.hostSourceDigest
    && hostExecutable.digest === ownership.runtime.hostExecutableDigest;
}

async function copySnapshotFiles(snapshot, sourceRoot, destinationRoot) {
  for (const entry of snapshot.files) {
    const parts = entry.relative.split('/');
    const source = path.join(sourceRoot, ...parts);
    const destination = path.join(destinationRoot, ...parts);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const measured = await boundedFileDigest(destination, MAX_PACKAGE_FILE_BYTES);
    if (measured.size !== entry.size || measured.digest !== entry.digest) throw new Error('legacy protected package copy verification failed');
  }
}

async function stageLegacyGeneration(context) {
  const { basePlan, targetPlan, fixed, ownership, measureCandidate } = context;
  if (await verifyGenerationDirectory(targetPlan, ownership, measureCandidate)) return false;
  if (await verifyGenerationDirectory(targetPlan, ownership, measureCandidate, { allowUnversioned: true })) {
    const manifestPath = path.win32.join(targetPlan.runtime.generationDirectory, 'generation.json');
    const manifest = await readBoundedJson(manifestPath, MAX_CONTROL_BYTES, 'unversioned legacy generation manifest');
    const temporary = `${manifestPath}.protocol.tmp`;
    await rm(temporary, { force: true });
    await writeFile(temporary, `${JSON.stringify({ ...manifest, hostCommandProtocol: WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_LEGACY_V1 })}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, manifestPath);
    return true;
  }
  try {
    await boundedRealDirectory(targetPlan.runtime.generationDirectory, 'legacy generation directory');
    throw new Error('legacy generation directory exists with invalid evidence');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const exact = await exactLegacyEvidence(fixed, ownership, measureCandidate);
  if (exact.generation !== targetPlan.runtime.generation) throw new Error('legacy generation identity changed before staging');
  await mkdir(basePlan.runtime.generationsDirectory, { recursive: true });
  await boundedRealDirectory(basePlan.runtime.generationsDirectory, 'legacy generation container');
  const staging = `${targetPlan.runtime.generationDirectory}.legacy-staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, 'bin'), { recursive: true });
  await mkdir(path.join(staging, 'runtime', 'package'), { recursive: true });
  await copySnapshotFiles(exact.candidate.sourceSnapshot, fixed.packageDirectory, path.join(staging, 'runtime', 'package'));
  await copyFile(fixed.nodeExecutable, path.join(staging, 'bin', 'node.exe'));
  await copyFile(fixed.serviceHostSource, path.join(staging, 'runtime', 'windows-lifecycle-authority-host.cs'));
  await copyFile(fixed.serviceHostExecutable, path.join(staging, 'bin', 'devbridge-lifecycle-authority-host.exe'));
  const stagedPlan = Object.freeze({
    ...targetPlan,
    runtime: Object.freeze({
      ...targetPlan.runtime,
      generationDirectory: staging,
      packageDirectory: path.join(staging, 'runtime', 'package'),
      nodeExecutable: path.join(staging, 'bin', 'node.exe'),
      serviceHostSource: path.join(staging, 'runtime', 'windows-lifecycle-authority-host.cs'),
      serviceHostExecutable: path.join(staging, 'bin', 'devbridge-lifecycle-authority-host.exe'),
    }),
  });
  const stagedCandidate = await measureCandidate({ packageRoot: stagedPlan.runtime.packageDirectory, nodeExecutable: stagedPlan.runtime.nodeExecutable });
  const [stagedSource, stagedExecutable] = await Promise.all([
    boundedFileDigest(stagedPlan.runtime.serviceHostSource, MAX_PACKAGE_FILE_BYTES),
    boundedFileDigest(stagedPlan.runtime.serviceHostExecutable, MAX_NODE_BYTES),
  ]);
  if (stagedCandidate.evidence.packageDigest !== ownership.runtime.packageDigest
      || stagedCandidate.evidence.nodeDigest !== ownership.runtime.nodeDigest
      || stagedSource.digest !== ownership.runtime.hostSourceDigest
      || stagedExecutable.digest !== ownership.runtime.hostExecutableDigest) {
    throw new Error('legacy protected runtime staged bytes failed exact verification');
  }
  const manifest = Object.freeze({
    protocol: WINDOWS_LIFECYCLE_AUTHORITY_GENERATION_PROTOCOL,
    generation: targetPlan.runtime.generation,
    packageDigest: ownership.runtime.packageDigest,
    nodeDigest: ownership.runtime.nodeDigest,
    hostSourceDigest: ownership.runtime.hostSourceDigest,
    hostExecutableDigest: ownership.runtime.hostExecutableDigest,
    hostCommandProtocol: WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_LEGACY_V1,
  });
  await writeFile(path.join(staging, 'generation.json'), `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(staging, targetPlan.runtime.generationDirectory);
  if (!await verifyGenerationDirectory(targetPlan, ownership, measureCandidate)) throw new Error('legacy generation failed verification after publication');
  return true;
}

async function configureServiceCommand(plan, command, invoke, environment) {
  await invokeSc(invoke, ['config', plan.service.name, 'binPath=', command, 'start=', 'auto', 'obj=', plan.service.logonAccount], 'Windows lifecycle authority legacy service configuration', environment);
  await invokeSc(invoke, ['description', plan.service.name, plan.service.description], 'Windows lifecycle authority legacy service evidence configuration', environment);
}

export async function probeWindowsLifecycleAuthorityLegacyRuntime(plan, clientFactory, {
  now = () => Date.now(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  deadlineMs = HEALTH_PROBE_DEADLINE_MS,
  attemptMs = HEALTH_PROBE_ATTEMPT_MS,
  retryMs = HEALTH_PROBE_RETRY_MS,
} = {}) {
  if (typeof clientFactory !== 'function' || typeof now !== 'function' || typeof wait !== 'function') {
    throw new TypeError('legacy runtime health probe composition is invalid');
  }
  for (const [name, value] of Object.entries({ deadlineMs, attemptMs, retryMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`legacy runtime health probe ${name} is invalid`);
  }
  const deadline = now() + deadlineMs;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    try {
      const client = clientFactory({
        stateDirectory: plan.stateDirectory,
        platform: 'win32',
        connectTimeoutMs: Math.min(attemptMs, remaining),
      });
      const value = await client.inspect();
      if (value?.protocol === 'devbridge/environment-operator-v1') return true;
    } catch {}
    const afterAttempt = deadline - now();
    if (afterAttempt <= 0) return false;
    await wait(Math.min(retryMs, afterAttempt));
  }
}

function boundedDiagnosticError(error) {
  const text = String(error?.message ?? error ?? 'unknown failure').replace(/[\r\n]+/gu, ' ').trim();
  return text.slice(0, 1024) || 'unknown failure';
}

function diagnosticReporter(onDiagnostic) {
  const events = [];
  let sequence = 0;
  return Object.freeze({
    emit(phase, state, detail = null) {
      const event = Object.freeze({
        protocol: DIAGNOSTIC_PROTOCOL,
        sequence: sequence += 1,
        phase,
        state,
        detail,
      });
      events.push(event);
      try { onDiagnostic?.(event); } catch {}
      return event;
    },
    events: () => Object.freeze([...events]),
  });
}

function observationDetail(observation) {
  return Object.freeze({
    mode: observation?.mode ?? 'unknown',
    staged: observation?.staged === true,
    journalPhase: observation?.journal?.phase ?? null,
    pending: observation?.journal?.pending ?? null,
  });
}

export function classifyWindowsLifecycleAuthorityLegacyService(service, fixed, targetPlan) {
  if (!service.exists) return 'missing';
  if (serviceMatches(service, fixed.serviceCommand, fixed.service, {
    allowMissingDescription: true,
    allowRetiredVirtualLogon: true,
  })) return running(service) ? 'fixed-running' : 'fixed-stopped';
  if (serviceMatches(service, targetPlan.serviceCommand, targetPlan.service, {
    allowRetiredVirtualLogon: true,
  })) return running(service) ? 'generation-running' : 'generation-stopped';
  return 'foreign';
}

export function classifyWindowsLifecycleAuthorityRuntimeLayout({
  generationsExist,
  journalPresent,
  mode,
  generationVerified = false,
} = {}) {
  if (typeof generationsExist !== 'boolean' || typeof journalPresent !== 'boolean' || typeof generationVerified !== 'boolean') {
    throw new TypeError('Windows lifecycle authority runtime layout evidence is invalid');
  }
  if (!['fixed-running', 'fixed-stopped', 'generation-running', 'generation-stopped', 'missing', 'foreign'].includes(mode)) {
    throw new TypeError('Windows lifecycle authority runtime service mode is invalid');
  }
  if (mode === 'missing' || mode === 'foreign') {
    throw new Error('legacy protected runtime service evidence is missing or foreign');
  }
  if (journalPresent || mode === 'fixed-running' || mode === 'fixed-stopped') return 'legacy';
  if (!generationsExist || !generationVerified) {
    throw new Error('generation-addressed protected runtime evidence is incomplete or inconsistent');
  }
  return 'generation';
}

async function initializerResidueIsSafe(basePlan) {
  const entries = await readdir(basePlan.protectedRoot);
  if (entries.length === 0) return true;
  if (entries.length !== 1 || entries[0] !== path.win32.basename(basePlan.runtime.generationsDirectory)) return false;
  try {
    await boundedRealDirectory(basePlan.runtime.generationsDirectory, 'protected generation container');
    return (await readdir(basePlan.runtime.generationsDirectory)).length === 0;
  } catch {
    return false;
  }
}

export async function createWindowsLifecycleAuthorityLegacyRuntimeMechanics({
  stateDirectory,
  platform = process.platform,
  invoke = invokeCommand,
  environment = process.env,
} = {}, {
  inspectHostPort = inspectHost,
  inspectServicePort = inspectService,
  measureCandidate = measureWindowsLifecycleAuthorityCandidate,
  clientFactory = createConfiguredLifecycleAuthorityClient,
} = {}) {
  if (platform !== 'win32') return Object.freeze({ notRequired: true });
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('legacy runtime migration stateDirectory is required');
  if (typeof invoke !== 'function' || typeof inspectHostPort !== 'function' || typeof inspectServicePort !== 'function' || typeof measureCandidate !== 'function' || typeof clientFactory !== 'function') {
    throw new TypeError('legacy runtime migration composition is invalid');
  }
  const host = await inspectHostPort({ invoke, environment });
  const basePlan = createWindowsLifecycleAuthorityPlan({
    stateDirectory,
    programDataDirectory: host.programData,
    operatorSid: host.operatorSid,
  });

  let rootExists = true;
  try { await boundedRealDirectory(basePlan.protectedRoot, 'legacy protected authority root'); }
  catch (error) { if (error?.code === 'ENOENT') rootExists = false; else throw error; }
  if (!rootExists) return Object.freeze({ notRequired: true });

  const journal = await loadJournal(basePlan);
  if (journal?.phase === 'complete') return Object.freeze({ notRequired: true });
  let generationsExist = true;
  try { await boundedRealDirectory(basePlan.runtime.generationsDirectory, 'protected generation container'); }
  catch (error) { if (error?.code === 'ENOENT') generationsExist = false; else throw error; }
  let ownershipRecord;
  try {
    ownershipRecord = await readBoundedJson(basePlan.ownershipManifest, MAX_CONTROL_BYTES, 'legacy protected runtime ownership');
  } catch (error) {
    if (error?.code === 'ENOENT' && journal == null && await initializerResidueIsSafe(basePlan)) {
      return Object.freeze({ notRequired: true });
    }
    throw error;
  }

  const ownership = normalizeOwnership(ownershipRecord, basePlan, host.operatorSid);
  const fixed = fixedRuntimePlan(basePlan, ownership.runtime);
  const targetPlan = bindWindowsLifecycleAuthorityRuntime(basePlan, {
    ...ownership.runtime,
    hostCommandProtocol: WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_LEGACY_V1,
  });
  const service = await inspectServicePort(targetPlan, invoke, environment);
  const mode = classifyWindowsLifecycleAuthorityLegacyService(service, fixed, targetPlan);
  const generationVerified = (mode === 'generation-running' || mode === 'generation-stopped')
    && generationsExist
    && await verifyGenerationDirectory(targetPlan, ownership, measureCandidate);
  const layout = classifyWindowsLifecycleAuthorityRuntimeLayout({
    generationsExist,
    journalPresent: journal != null,
    mode,
    generationVerified,
  });
  if (layout === 'generation') return Object.freeze({ notRequired: true });

  const exact = await exactLegacyEvidence(fixed, ownership, measureCandidate);
  if (targetPlan.runtime.generation !== exact.generation) throw new Error('legacy protected runtime generation derivation is inconsistent');
  if (journal != null && journal.generation !== exact.generation) throw new Error('legacy protected runtime journal generation is stale');
  if (host.elevated !== true) throw new Error('legacy protected runtime migration requires the bounded elevated child');

  const initialJournal = journal ?? await saveJournal(basePlan, Object.freeze({
    protocol: JOURNAL_PROTOCOL,
    authorityIdentity: basePlan.authorityIdentity,
    generation: exact.generation,
    phase: 'observed',
    pending: null,
  }));
  const context = Object.freeze({ basePlan, targetPlan, fixed, ownership, measureCandidate, invoke, environment, clientFactory });

  return Object.freeze({
    notRequired: false,
    generation: exact.generation,
    journal: initialJournal,
    async observe() {
      const currentService = await inspectServicePort(targetPlan, invoke, environment);
      return Object.freeze({
        mode: classifyWindowsLifecycleAuthorityLegacyService(currentService, fixed, targetPlan),
        staged: await verifyGenerationDirectory(targetPlan, ownership, measureCandidate),
        journal: await loadJournal(basePlan),
      });
    },
    async checkpoint({ phase, effect = null, state = null }) {
      if (!PHASES.has(phase)) throw new TypeError('legacy runtime migration checkpoint phase is invalid');
      const pending = effect == null ? null : Object.freeze({ effect, state });
      return saveJournal(basePlan, Object.freeze({
        protocol: JOURNAL_PROTOCOL,
        authorityIdentity: basePlan.authorityIdentity,
        generation: exact.generation,
        phase,
        pending,
      }));
    },
    async diagnose() {
      async function capture(name, operation) {
        try { return Object.freeze({ name, ok: true, value: await operation() }); }
        catch (error) { return Object.freeze({ name, ok: false, error: boundedDiagnosticError(error) }); }
      }
      return Promise.all([
        capture('service', async () => {
          const currentService = await inspectServicePort(targetPlan, invoke, environment);
          return Object.freeze({
            mode: classifyWindowsLifecycleAuthorityLegacyService(currentService, fixed, targetPlan),
            state: currentService.state,
            startMode: currentService.startMode,
            startName: currentService.startName,
            pathName: currentService.pathName,
            description: currentService.description,
          });
        }),
        capture('generation', async () => Object.freeze({
          generation: targetPlan.runtime.generation,
          verified: await verifyGenerationDirectory(targetPlan, ownership, measureCandidate),
        })),
        capture('journal', async () => {
          const current = await loadJournal(basePlan);
          return Object.freeze({ phase: current?.phase ?? null, pending: current?.pending ?? null });
        }),
        capture('read-endpoint', async () => {
          const client = clientFactory({ stateDirectory: targetPlan.stateDirectory, platform: 'win32', connectTimeoutMs: 1_000 });
          const value = await client.inspect();
          return Object.freeze({ protocol: value?.protocol ?? null });
        }),
      ]);
    },
    async commandContract() {
      const manifest = await readBoundedJson(
        path.win32.join(targetPlan.runtime.generationDirectory, 'generation.json'),
        MAX_CONTROL_BYTES,
        'legacy generation manifest',
      );
      const hostSource = await readFile(targetPlan.runtime.serviceHostSource, 'utf8');
      const commandHasAcceptancePipe = targetPlan.serviceCommand.includes('"--acceptance-pipe"');
      const hostSourceHasAcceptancePipe = hostSource.includes('--acceptance-pipe');
      if (manifest.hostCommandProtocol !== WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_LEGACY_V1
          || targetPlan.hostCommandProtocol !== WINDOWS_LIFECYCLE_AUTHORITY_HOST_COMMAND_LEGACY_V1
          || commandHasAcceptancePipe
          || hostSourceHasAcceptancePipe) {
        throw new Error('legacy generation host command contract is inconsistent');
      }
      return Object.freeze({
        manifestProtocol: manifest.hostCommandProtocol,
        planProtocol: targetPlan.hostCommandProtocol,
        commandHasAcceptancePipe,
        hostSourceHasAcceptancePipe,
        compatible: true,
      });
    },
    stage: () => stageLegacyGeneration(context),
    async quiesce() {
      const currentService = await inspectServicePort(targetPlan, invoke, environment);
      const modeNow = classifyWindowsLifecycleAuthorityLegacyService(currentService, fixed, targetPlan);
      if (modeNow === 'fixed-stopped' || modeNow === 'generation-stopped') return false;
      if (modeNow !== 'fixed-running') throw new Error('legacy runtime quiesce observed unexpected service identity');
      await invokePowerShell(invoke, STOP_SERVICE_SCRIPT, { name: targetPlan.service.name }, 'Windows lifecycle authority legacy service stop', environment);
      return true;
    },
    async promote() {
      const currentService = await inspectServicePort(targetPlan, invoke, environment);
      const modeNow = classifyWindowsLifecycleAuthorityLegacyService(currentService, fixed, targetPlan);
      if (modeNow === 'generation-stopped' || modeNow === 'generation-running') return false;
      if (modeNow !== 'fixed-stopped') throw new Error('legacy runtime promotion requires the exact fixed service to be stopped');
      if (!await verifyGenerationDirectory(targetPlan, ownership, measureCandidate)) throw new Error('legacy runtime promotion target is not exact');
      await configureServiceCommand(targetPlan, targetPlan.serviceCommand, invoke, environment);
      return true;
    },
    async start() {
      const currentService = await inspectServicePort(targetPlan, invoke, environment);
      const modeNow = classifyWindowsLifecycleAuthorityLegacyService(currentService, fixed, targetPlan);
      if (modeNow === 'generation-running') return false;
      if (modeNow !== 'generation-stopped') throw new Error('legacy runtime start requires the exact generation service to be stopped');
      await invokePowerShell(invoke, START_SERVICE_SCRIPT, { name: targetPlan.service.name }, 'Windows lifecycle authority legacy generation start', environment);
      return true;
    },
    health: () => probeWindowsLifecycleAuthorityLegacyRuntime(targetPlan, clientFactory),
    async restore() {
      let currentService = await inspectServicePort(targetPlan, invoke, environment);
      let modeNow = classifyWindowsLifecycleAuthorityLegacyService(currentService, fixed, targetPlan);
      if (modeNow === 'fixed-running') return probeWindowsLifecycleAuthorityLegacyRuntime({ ...targetPlan, serviceCommand: fixed.serviceCommand }, clientFactory);
      if (modeNow === 'generation-running') {
        await invokePowerShell(invoke, STOP_SERVICE_SCRIPT, { name: targetPlan.service.name }, 'Windows lifecycle authority legacy rollback stop', environment);
        currentService = await inspectServicePort(targetPlan, invoke, environment);
        modeNow = classifyWindowsLifecycleAuthorityLegacyService(currentService, fixed, targetPlan);
      }
      if (modeNow === 'generation-stopped') {
        await configureServiceCommand({ ...targetPlan, service: fixed.service }, fixed.serviceCommand, invoke, environment);
        modeNow = 'fixed-stopped';
      }
      if (modeNow !== 'fixed-stopped') throw new Error('legacy runtime rollback cannot prove the exact fixed service identity');
      await invokePowerShell(invoke, START_SERVICE_SCRIPT, { name: targetPlan.service.name }, 'Windows lifecycle authority legacy rollback start', environment);
      return probeWindowsLifecycleAuthorityLegacyRuntime({ ...targetPlan, serviceCommand: fixed.serviceCommand }, clientFactory);
    },
  });
}

function result({ ready, required, changed = false, generation = null, blocker = null, diagnostics = Object.freeze([]) }) {
  return Object.freeze({ protocol: PROTOCOL, ready, required, changed, generation, blocker, diagnostics });
}

async function checkpointEffect(mechanics, phase, effect, operation, reporter) {
  reporter.emit(effect, 'planned', Object.freeze({ phase }));
  await mechanics.checkpoint({ phase, effect, state: 'planned' });
  reporter.emit(effect, 'attempted', Object.freeze({ phase }));
  await mechanics.checkpoint({ phase, effect, state: 'attempted' });
  try {
    const changed = await operation();
    reporter.emit(effect, 'completed', Object.freeze({ phase, changed: changed === true }));
    return changed === true;
  } catch (error) {
    reporter.emit(effect, 'failed', Object.freeze({ phase, error: boundedDiagnosticError(error) }));
    throw error;
  }
}

async function runDiagnosticFanout(mechanics, reporter, phase) {
  reporter.emit(phase, 'attempted');
  if (typeof mechanics.diagnose !== 'function') {
    reporter.emit(phase, 'completed', Object.freeze({ checks: Object.freeze([]) }));
    return;
  }
  try {
    const checks = await mechanics.diagnose();
    reporter.emit(phase, 'completed', Object.freeze({ checks: Object.freeze(checks) }));
  } catch (error) {
    reporter.emit(phase, 'failed', Object.freeze({ error: boundedDiagnosticError(error) }));
  }
}

export async function reconcileWindowsLifecycleAuthorityLegacyRuntime(options = {}, {
  createMechanics = createWindowsLifecycleAuthorityLegacyRuntimeMechanics,
} = {}) {
  const reporter = diagnosticReporter(options.onDiagnostic);
  if (typeof createMechanics !== 'function') throw new TypeError('legacy runtime migration mechanics factory is invalid');
  if (options.platform != null && options.platform !== 'win32') return result({ ready: true, required: false, diagnostics: reporter.events() });
  let mechanics;
  try { mechanics = await createMechanics(options); }
  catch (error) {
    reporter.emit('admission', 'failed', Object.freeze({ error: boundedDiagnosticError(error) }));
    return result({
      ready: false,
      required: true,
      blocker: `Legacy Windows protected authority evidence is incomplete or inconsistent. DevBridge will not seize or rewrite it. Primary failure: ${boundedDiagnosticError(error)}`,
      diagnostics: reporter.events(),
    });
  }
  if (mechanics?.notRequired === true) return result({ ready: true, required: false, diagnostics: reporter.events() });
  if (!mechanics || typeof mechanics.observe !== 'function' || typeof mechanics.checkpoint !== 'function') throw new TypeError('legacy runtime migration mechanics are invalid');

  let changed = false;
  let primaryFailure = null;
  reporter.emit('migration', 'started', Object.freeze({ generation: mechanics.generation ?? null }));
  try {
    let observation = await mechanics.observe();
    reporter.emit('observe', 'completed', observationDetail(observation));
    if (!observation.staged) {
      changed = (await checkpointEffect(mechanics, 'observed', 'stage', mechanics.stage, reporter)) || changed;
      observation = await mechanics.observe();
      reporter.emit('observe', 'completed', observationDetail(observation));
    }
    if (!observation.staged) throw new Error('legacy generation did not become exact after staging');
    await mechanics.checkpoint({ phase: 'staged' });
    reporter.emit('command-contract', 'attempted');
    if (typeof mechanics.commandContract !== 'function') throw new Error('legacy generation command contract proof is unavailable');
    const commandContract = await mechanics.commandContract();
    reporter.emit('command-contract', 'completed', commandContract);

    if (observation.mode === 'fixed-running') {
      changed = (await checkpointEffect(mechanics, 'staged', 'quiesce', mechanics.quiesce, reporter)) || changed;
      observation = await mechanics.observe();
      reporter.emit('observe', 'completed', observationDetail(observation));
    }
    if (observation.mode === 'fixed-stopped') {
      await mechanics.checkpoint({ phase: 'quiesced' });
      changed = (await checkpointEffect(mechanics, 'quiesced', 'promote', mechanics.promote, reporter)) || changed;
      observation = await mechanics.observe();
      reporter.emit('observe', 'completed', observationDetail(observation));
    }
    if (observation.mode === 'generation-stopped') {
      await mechanics.checkpoint({ phase: 'promoted' });
      changed = (await checkpointEffect(mechanics, 'promoted', 'start', mechanics.start, reporter)) || changed;
      observation = await mechanics.observe();
      reporter.emit('observe', 'completed', observationDetail(observation));
    }
    if (observation.mode !== 'generation-running') throw new Error('legacy migration did not reach the exact generation service');
    await mechanics.checkpoint({ phase: 'started' });
    reporter.emit('health', 'attempted');
    if (!await mechanics.health()) {
      reporter.emit('health', 'failed', Object.freeze({ error: 'legacy generation health proof failed' }));
      throw new Error('legacy generation health proof failed');
    }
    reporter.emit('health', 'completed');
    await mechanics.checkpoint({ phase: 'complete' });
    reporter.emit('migration', 'completed', Object.freeze({ generation: mechanics.generation }));
    return result({ ready: true, required: true, changed, generation: mechanics.generation, diagnostics: reporter.events() });
  } catch (error) {
    primaryFailure = boundedDiagnosticError(error);
    reporter.emit('migration', 'failed', Object.freeze({ error: primaryFailure }));
    await runDiagnosticFanout(mechanics, reporter, 'diagnose-before-rollback');
    let restored = false;
    try {
      reporter.emit('restore', 'planned');
      await mechanics.checkpoint({ phase: 'started', effect: 'restore', state: 'planned' });
      reporter.emit('restore', 'attempted');
      await mechanics.checkpoint({ phase: 'started', effect: 'restore', state: 'attempted' });
      restored = await mechanics.restore() === true;
      if (restored) await mechanics.checkpoint({ phase: 'restored' });
      reporter.emit('restore', restored ? 'completed' : 'failed', restored ? null : Object.freeze({ error: 'exact rollback health proof failed' }));
    } catch (restoreError) {
      reporter.emit('restore', 'failed', Object.freeze({ error: boundedDiagnosticError(restoreError) }));
    }
    await runDiagnosticFanout(mechanics, reporter, 'diagnose-after-rollback');
    return result({
      ready: false,
      required: true,
      changed,
      generation: mechanics.generation ?? null,
      blocker: `Legacy Windows protected authority migration did not complete. Primary failure: ${primaryFailure}. Rollback restored: ${restored}.`,
      diagnostics: reporter.events(),
    });
  }
}

export {
  JOURNAL_PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_LEGACY_RUNTIME_JOURNAL_PROTOCOL,
  PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_LEGACY_RUNTIME_MIGRATION_PROTOCOL,
};
