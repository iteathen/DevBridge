import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-elevation-v1';
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
]);
const ALLOWED_LAUNCHERS = new Set(['devbridge-entry.mjs', 'devbridge-stage0.mjs']);
const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const BROKER_RESULT_PROTOCOL = 'devbridge/windows-lifecycle-authority-elevation-broker-v1';
const CHILD_RESULT_DIRECTORY = /^\.lifecycle-authority-elevation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_BROKER_RESULT_BYTES = 80 * 1024;
const ELEVATION_TRANSACTION_TIMEOUT_MS = 45 * 60_000;

const BROKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$limit = 32KB
$inputFile = '__INPUT_FILE__'
$expectedHead = '__EXPECTED_HEAD__'
$directory = [IO.Path]::GetDirectoryName($inputFile)
$resultFile = [IO.Path]::Combine($directory, 'result.json')
$stdoutFile = [IO.Path]::Combine($directory, 'stdout.txt')
$stderrFile = [IO.Path]::Combine($directory, 'stderr.txt')
$record = [ordered]@{
  protocol = 'devbridge/windows-lifecycle-authority-elevation-broker-v1'
  requestedHead = $expectedHead
  started = $false
  exitCode = $null
  stdout = ''
  stderr = ''
  error = $null
  outputTruncated = $false
}
$brokerExit = 1
function Read-BoundedText([string]$file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return '' }
  $item = Get-Item -LiteralPath $file -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'broker output used filesystem indirection' }
  if ($item.Length -gt $limit) { $script:record.outputTruncated = $true; return '' }
  return [IO.File]::ReadAllText($file)
}
try {
  $inputItem = Get-Item -LiteralPath $inputFile -Force
  if (($inputItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $inputItem.Length -lt 2 -or $inputItem.Length -gt 8KB) { throw 'broker input is not one bounded real file' }
  $data = [IO.File]::ReadAllText($inputFile) | ConvertFrom-Json
  $node = [string]$data.node
  $launcherPath = [string]$data.launcher
  $head = [string]$data.runnerHead
  $devBridgeHome = [string]$data.home
  if ($head -ne $expectedHead) { throw 'broker input runner identity does not match its encoded authority' }
  if (-not [IO.Path]::IsPathRooted($node) -or -not [IO.Path]::IsPathRooted($launcherPath)) { throw 'broker executable identity is not absolute' }
  if (-not [IO.Path]::IsPathRooted($devBridgeHome)) { throw 'broker DevBridge home is not absolute' }
  if ($head -notmatch '^[0-9a-f]{40}$') { throw 'broker runner identity is not exact' }
  if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw 'broker executable identity is unavailable' }
  $env:DEVBRIDGE_HOME = $devBridgeHome
  $env:DEVBRIDGE_LIFECYCLE_AUTHORITY_ELEVATED_CHILD = '1'
  $launcher = '"' + $launcherPath.Replace('"', '') + '"'
  $child = Start-Process -FilePath $node -ArgumentList @(
    $launcher,
    '--ref',
    $head,
    'setup',
    '--lifecycle-authority-child',
    '--no-update'
  ) -Wait -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
  $record.started = $true
  $record.exitCode = [int]$child.ExitCode
  $record.stdout = Read-BoundedText $stdoutFile
  $record.stderr = Read-BoundedText $stderrFile
  $brokerExit = [int]$child.ExitCode
} catch {
  $record.exitCode = $brokerExit
  try { $record.stdout = Read-BoundedText $stdoutFile } catch {}
  try { $record.stderr = Read-BoundedText $stderrFile } catch {}
  $message = [string]$_.Exception.Message
  $record.error = ($message -replace '[\r\n]+', ' ').Trim()
  if ($record.error.Length -gt 2048) { $record.error = $record.error.Substring(0, 2048) }
} finally {
  Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
  $json = $record | ConvertTo-Json -Compress
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + [Environment]::NewLine)
  $stream = [IO.File]::Open($resultFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
exit $brokerExit
`;

const ELEVATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
try {
  $brokerCommand = [string]$data.brokerCommand
  if ($brokerCommand.Length -lt 2 -or $brokerCommand.Length -gt 128KB -or $brokerCommand -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'encoded elevation broker command is invalid' }
  $broker = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', $brokerCommand
  ) -Verb RunAs -Wait -PassThru
  @{ started = $true; exitCode = [int]$broker.ExitCode } | ConvertTo-Json -Compress
} catch {
  @{ started = $false; exitCode = $null } | ConvertTo-Json -Compress
}
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function renderedBrokerScript(inputFile, runnerHead) {
  const inputLiteral = inputFile.replaceAll("'", "''");
  return BROKER_SCRIPT
    .replace('__INPUT_FILE__', inputLiteral)
    .replace('__EXPECTED_HEAD__', runnerHead);
}

function invocationSucceeded(result) {
  return result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true && result?.outputTruncated !== true;
}

function absoluteLocalPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('"') || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute local path`);
  }
  return path.resolve(value);
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function boundedRealFile(file, name) {
  const resolved = path.resolve(file);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${name} must be a real regular file`);
  }
  return resolved;
}

async function managedStateRoot(home) {
  const state = path.join(home, 'state');
  const stateInfo = await lstat(state);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
    throw new Error('Windows lifecycle authority elevation state root must be a real directory');
  }
  const canonicalHome = await realpath(home);
  const canonicalState = await realpath(state);
  if (!pathIsWithin(canonicalHome, canonicalState)) {
    throw new Error('Windows lifecycle authority elevation state root escaped the managed DevBridge home');
  }
  return Object.freeze({ state, canonicalState });
}

async function childResultTarget(home) {
  const { state } = await managedStateRoot(home);
  const directory = path.join(state, `.lifecycle-authority-elevation-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  return Object.freeze({ state, directory, input: path.join(directory, 'input.json'), file: path.join(directory, 'result.json') });
}

async function cleanupChildResultTarget(target) {
  try {
    const info = await lstat(target.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(target.directory) !== target.state
        || !CHILD_RESULT_DIRECTORY.test(path.basename(target.directory))
        || path.dirname(target.input) !== target.directory || path.basename(target.input) !== 'input.json'
        || path.dirname(target.file) !== target.directory || path.basename(target.file) !== 'result.json') return;
    await rm(target.directory, { recursive: true, force: true });
  } catch {}
}

async function cleanupCompletedChildResultTargets(root) {
  let state;
  let canonicalState;
  let entries;
  try {
    ({ state, canonicalState } = await managedStateRoot(root));
    entries = await readdir(state, { withFileTypes: true });
  }
  catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !CHILD_RESULT_DIRECTORY.test(entry.name)) continue;
    const directory = path.join(state, entry.name);
    const target = Object.freeze({
      state,
      directory,
      input: path.join(directory, 'input.json'),
      file: path.join(directory, 'result.json'),
    });
    try {
      const directoryInfo = await lstat(directory);
      const canonicalDirectory = await realpath(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
          || !samePath(path.dirname(canonicalDirectory), canonicalState, 'win32')) continue;
      const contents = await readdir(directory, { withFileTypes: true });
      if (contents.length !== 1 || contents[0].name !== 'result.json' || !contents[0].isFile()) continue;
      await readBrokerResult(target);
      await cleanupChildResultTarget(target);
    } catch {}
  }
}

function boundedBrokerText(value) {
  const text = String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
  return text.length > 0 ? text.slice(0, 2048) : null;
}

async function readBrokerResult(target) {
  const info = await lstat(target.file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAX_BROKER_RESULT_BYTES) {
    throw new Error('Windows lifecycle authority elevation broker result is not a bounded real file');
  }
  const value = JSON.parse(await readFile(target.file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.protocol !== BROKER_RESULT_PROTOCOL || !EXACT_HEAD.test(value.requestedHead ?? '')
      || typeof value.started !== 'boolean' || (value.exitCode != null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255))
      || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
      || (value.error != null && typeof value.error !== 'string') || typeof value.outputTruncated !== 'boolean'
      || Buffer.byteLength(value.stdout, 'utf8') > 32 * 1024 || Buffer.byteLength(value.stderr, 'utf8') > 32 * 1024) {
    throw new Error('Windows lifecycle authority elevation broker result is invalid');
  }
  return Object.freeze({
    ...value,
    stdout: String(value.stdout).trim(),
    stderr: String(value.stderr).trim(),
    error: boundedBrokerText(value.error),
  });
}

function childBlocker(broker) {
  const parsed = parseChildOutput(broker?.stdout);
  if (parsed.result && typeof parsed.result.blocker === 'string') {
    const rendered = parsed.diagnostics.map((event) => {
      let detail = '';
      if (event?.detail?.error) detail = `:${String(event.detail.error).replace(/[\r\n;]+/gu, ' ').slice(0, 512)}`;
      else if (event?.detail?.ready === false && event?.detail?.reason) detail = `:ready=false reason=${String(event.detail.reason).replace(/[\r\n;]+/gu, ' ').slice(0, 512)}`;
      else if (Array.isArray(event?.detail?.checks)) {
        detail = `:${event.detail.checks.map((check) => {
          if (check?.ok !== true) return `${check?.name ?? 'unknown'}=error(${String(check?.error ?? 'unknown').slice(0, 128)})`;
          if (check.name === 'service') return `service=ok(${check.value?.mode ?? 'unknown'}/${check.value?.state ?? 'unknown'})`;
          if (check.name === 'generation') return `generation=ok(${check.value?.verified === true})`;
          if (check.name === 'journal') return `journal=ok(${check.value?.phase ?? 'none'})`;
          if (check.name === 'read-endpoint') return `read-endpoint=ok(${check.value?.protocol ?? 'none'})`;
          return `${check?.name ?? 'unknown'}=ok`;
        }).join(',')}`;
      }
      return `${event.sequence}:${event.phase}:${event.state}${detail}`;
    });
    const failures = rendered.filter((_, index) => parsed.diagnostics[index]?.state === 'failed').join(';');
    const evidence = rendered.filter((_, index) => Array.isArray(parsed.diagnostics[index]?.detail?.checks)).join(';');
    const tail = rendered.slice(-12).join(';');
    const checkpoints = rendered.join(';');
    const failureIndex = failures ? ` Failures: ${failures}.` : '';
    const evidenceIndex = evidence ? ` Evidence: ${evidence}.` : '';
    const tailIndex = tail ? ` Tail: ${tail}.` : '';
    return boundedBrokerText(checkpoints ? `${parsed.result.blocker}${failureIndex}${evidenceIndex}${tailIndex} Checkpoints: ${checkpoints}` : parsed.result.blocker);
  }
  return broker?.error || broker?.stderr || null;
}

function parseChildOutput(output) {
  const lines = String(output ?? '').split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  const diagnostics = [];
  let result = null;
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value?.protocol === 'devbridge/windows-lifecycle-authority-migration-diagnostic-v1') diagnostics.push(value);
      if (value?.protocol === 'devbridge/windows-lifecycle-authority-elevated-child-v1') result = value;
    } catch {}
  }
  return Object.freeze({ diagnostics: Object.freeze(diagnostics), result });
}

export async function resolveWindowsLifecycleAuthorityElevationRunnerHead({ packageRoot = PACKAGE_ROOT } = {}) {
  const root = path.resolve(packageRoot);
  const git = path.join(root, '.git');
  const headFile = path.join(git, 'HEAD');
  let rootInfo;
  let gitInfo;
  let headInfo;
  try {
    [rootInfo, gitInfo, headInfo] = await Promise.all([lstat(root), lstat(git), lstat(headFile)]);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Windows lifecycle authority elevation requires an exact checkout identity');
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !gitInfo.isDirectory() || gitInfo.isSymbolicLink()
      || !headInfo.isFile() || headInfo.isSymbolicLink() || headInfo.size < 40 || headInfo.size > 128) {
    throw new Error('Windows lifecycle authority elevation checkout identity is not a bounded real file');
  }
  const head = String(await readFile(headFile, 'utf8')).trim().toLowerCase();
  if (!EXACT_HEAD.test(head)) throw new Error('Windows lifecycle authority elevation requires one detached exact checkout head');
  return head;
}

async function boundedManagedFile(root, file, name) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (!pathIsWithin(resolvedRoot, resolvedFile)) {
    throw new Error(`${name} escaped the managed DevBridge home`);
  }

  const rootInfo = await lstat(resolvedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`${name} managed root must be a real directory`);
  }
  const canonicalRoot = await realpath(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedFile);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = resolvedRoot;

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${name} must not use filesystem indirection`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`${name} must not traverse a non-directory path`);
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new Error(`${name} must be a real regular file`);
    }
    const canonical = await realpath(current);
    if (!pathIsWithin(canonicalRoot, canonical)) {
      throw new Error(`${name} escaped the managed DevBridge home`);
    }
  }

  return resolvedFile;
}

function samePath(left, right, platform) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function requestWindowsLifecycleAuthorityElevation({
  home,
  launcher,
  platform = process.platform,
  nodeExecutable = process.execPath,
  invoke = invokeCommand,
  environment = process.env,
} = {}, {
  resolveRunnerHead = resolveWindowsLifecycleAuthorityElevationRunnerHead,
} = {}) {
  if (platform !== 'win32') return Object.freeze({ protocol: PROTOCOL, attempted: false, completed: true, exitCode: 0, blocker: null });
  if (typeof invoke !== 'function' || typeof resolveRunnerHead !== 'function') throw new TypeError('Windows lifecycle authority elevation invocation contract is invalid');
  const root = absoluteLocalPath(home, 'DevBridge elevation home');
  const selectedLauncher = absoluteLocalPath(launcher, 'DevBridge elevation launcher');
  const node = absoluteLocalPath(nodeExecutable, 'DevBridge elevation Node executable');
  const expectedBin = path.join(root, 'bin');
  if (!samePath(path.dirname(selectedLauncher), expectedBin, platform) || !ALLOWED_LAUNCHERS.has(path.basename(selectedLauncher).toLowerCase())) {
    throw new Error('Windows lifecycle authority elevation launcher is outside the managed DevBridge entry boundary');
  }
  await Promise.all([
    boundedManagedFile(root, selectedLauncher, 'Windows lifecycle authority elevation launcher'),
    boundedRealFile(node, 'Windows lifecycle authority elevation Node executable'),
  ]);

  let runnerHead;
  try { runnerHead = String(await resolveRunnerHead()).trim().toLowerCase(); }
  catch {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: false,
      completed: false,
      exitCode: null,
      blocker: 'Windows lifecycle authority elevation requires the exact current DevBridge runner identity. Re-enter setup through an exact installed selector.',
    });
  }
  if (!EXACT_HEAD.test(runnerHead)) {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: false,
      completed: false,
      exitCode: null,
      blocker: 'Windows lifecycle authority elevation requires the exact current DevBridge runner identity. Re-enter setup through an exact installed selector.',
    });
  }

  await cleanupCompletedChildResultTargets(root);
  const childTarget = await childResultTarget(root);
  await writeFile(childTarget.input, `${JSON.stringify({ home: root, launcher: selectedLauncher, node, runnerHead })}\n`, { flag: 'wx', mode: 0o600 });
  const brokerCommand = encodedScript(renderedBrokerScript(childTarget.input, runnerHead));

  let result;
  try {
    result = await invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(ELEVATE_SCRIPT)],
      input: JSON.stringify({ brokerCommand }),
      timeoutMs: ELEVATION_TRANSACTION_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      environment,
    });
  } catch {
    await cleanupChildResultTarget(childTarget);
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: null,
      blocker: 'Windows lifecycle authority elevation could not be started. Re-run devbridge setup to retry the same protected reconciliation.',
    });
  }

  if (!invocationSucceeded(result)) {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: null,
      blocker: 'Windows lifecycle authority elevation did not complete. Re-run devbridge setup to retry the same protected reconciliation.',
    });
  }

  let brokerResult = null;
  try { brokerResult = await readBrokerResult(childTarget); }
  catch {}
  await cleanupChildResultTarget(childTarget);

  let value;
  try { value = JSON.parse(String(result.stdout ?? '').trim()); }
  catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.started !== 'boolean'
      || (value.exitCode != null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255))) {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: null,
      blocker: 'Windows lifecycle authority elevation returned invalid bounded status. Re-run devbridge setup to retry the same protected reconciliation.',
    });
  }
  if (value.started !== true) {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: null,
      blocker: 'Windows lifecycle authority elevation was cancelled or refused. No second elevation will be attempted by this setup invocation.',
    });
  }
  if (!brokerResult || brokerResult.requestedHead !== runnerHead || brokerResult.outputTruncated
      || brokerResult.exitCode !== value.exitCode) {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: value.exitCode,
      blocker: 'Windows lifecycle authority elevation broker did not return exact bounded completion evidence.',
    });
  }
  if (value.exitCode !== 0) {
    const blocker = childBlocker(brokerResult);
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: value.exitCode,
      blocker: blocker
        ? `Windows lifecycle authority elevated broker reported: ${blocker}`
        : 'Windows lifecycle authority elevated broker failed without bounded detail.',
    });
  }
  const childResult = parseChildOutput(brokerResult.stdout).result;
  if (brokerResult.started !== true || childResult?.protocol !== 'devbridge/windows-lifecycle-authority-elevated-child-v1' || childResult.ready !== true) {
    return Object.freeze({
      protocol: PROTOCOL,
      attempted: true,
      completed: false,
      exitCode: value.exitCode,
      blocker: 'The elevated Windows lifecycle authority child exited successfully without exact bounded readiness evidence.',
    });
  }
  return Object.freeze({ protocol: PROTOCOL, attempted: true, completed: true, exitCode: 0, blocker: null });
}

export { PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_ELEVATION_PROTOCOL };
