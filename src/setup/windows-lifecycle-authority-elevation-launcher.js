import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createCommandInvoker } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-elevation-launcher-v1';
const INPUT_PROTOCOL = 'devbridge/windows-lifecycle-authority-elevation-input-v2';
const BINDING_PROTOCOL = 'devbridge/windows-lifecycle-authority-elevation-binding-v1';
const RECEIPT_PROTOCOL = 'devbridge/windows-lifecycle-authority-elevation-launcher-receipt-v1';
const FILE_DESCRIPTION = 'DevBridge Protected Setup - reconcile lifecycle service and protected environment';
const PURPOSE = 'Reconcile the DevBridge-owned lifecycle service and protected environment configuration';
const DIRECTORY = 'windows-elevation-launchers';
const EXECUTABLE = 'DevBridge-Protected-Setup-Reconcile-Lifecycle-Service-and-Environment.exe';
const RECEIPT = 'receipt.json';
const SOURCE = 'windows-lifecycle-authority-elevation-launcher.cs';
const MANIFEST = 'windows-lifecycle-authority-elevation-launcher.manifest';
const DIGEST = /^[0-9a-f]{64}$/u;
const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const COMPILE_TIMEOUT_MS = 5 * 60_000;
const invokeCompileCommand = createCommandInvoker({ maximumTimeoutMs: COMPILE_TIMEOUT_MS });

const COMPILE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$source = [string]$data.source
$manifest = [string]$data.manifest
$output = [string]$data.output
if (-not [IO.Path]::IsPathRooted($source) -or -not [IO.Path]::IsPathRooted($manifest) -or -not [IO.Path]::IsPathRooted($output)) { throw 'elevation launcher compile paths must be absolute' }
if (Test-Path -LiteralPath $output) { throw 'elevation launcher output already exists' }
$options = '/target:winexe /win32manifest:"' + $manifest.Replace('"', '') + '"'
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateExecutable = $true
$parameters.OutputAssembly = $output
$parameters.CompilerOptions = $options
[void]$parameters.ReferencedAssemblies.Add('System.dll')
[void]$parameters.ReferencedAssemblies.Add('System.Core.dll')
[void]$parameters.ReferencedAssemblies.Add('System.Web.Extensions.dll')
Add-Type -LiteralPath $source -CompilerParameters $parameters -ErrorAction Stop
$item = Get-Item -LiteralPath $output -Force
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($output)
@{
  length = [long]$item.Length
  fileDescription = [string]$version.FileDescription
  productName = [string]$version.ProductName
} | ConvertTo-Json -Compress
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(file) {
  return sha256Bytes(await readFile(file));
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('"') || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute local path`);
  }
  return path.resolve(value);
}

function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realFile(file, name, { maximumBytes = null } = {}) {
  const resolved = path.resolve(file);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink() || (maximumBytes != null && (info.size < 1 || info.size > maximumBytes))) {
    throw new Error(`${name} must be one bounded real file`);
  }
  return Object.freeze({ file: resolved, size: info.size });
}

async function realDirectory(directory, name) {
  const resolved = path.resolve(directory);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} must be one real directory`);
  return resolved;
}

async function containedFile(root, file, name) {
  const resolvedRoot = await realDirectory(root, `${name} root`);
  const resolvedFile = path.resolve(file);
  if (!pathWithin(resolvedRoot, resolvedFile)) throw new Error(`${name} escaped its root`);
  const canonicalRoot = await realpath(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedFile);
  let current = resolvedRoot;
  for (const [index, segment] of relative.split(path.sep).filter(Boolean).entries()) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${name} used filesystem indirection`);
    if (index < relative.split(path.sep).filter(Boolean).length - 1 && !info.isDirectory()) throw new Error(`${name} traversed a non-directory`);
    if (!pathWithin(canonicalRoot, await realpath(current))) throw new Error(`${name} escaped its canonical root`);
  }
  await realFile(resolvedFile, name);
  return resolvedFile;
}

function normalizeRunner(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some((key) => !['head', 'root', 'launcher'].includes(key))
      || typeof raw.head !== 'string' || !EXACT_HEAD.test(raw.head)
      || typeof raw.root !== 'string' || typeof raw.launcher !== 'string') {
    throw new TypeError('Windows elevation launcher runner identity is invalid');
  }
  const root = absolutePath(raw.root, 'Windows elevation launcher runner root');
  const launcher = absolutePath(raw.launcher, 'Windows elevation launcher runner CLI');
  if (path.resolve(launcher) !== path.resolve(root, 'src', 'cli.js')) throw new Error('Windows elevation launcher runner CLI is not fixed');
  return Object.freeze({ head: raw.head, root, launcher });
}

async function binding({ home, runner, nodeExecutable }) {
  const root = absolutePath(home, 'Windows elevation launcher home');
  const exactRunner = normalizeRunner(runner);
  const node = absolutePath(nodeExecutable, 'Windows elevation launcher Node executable');
  const source = path.join(exactRunner.root, 'src', 'setup', SOURCE);
  const manifest = path.join(exactRunner.root, 'src', 'setup', MANIFEST);
  const headFile = path.join(exactRunner.root, '.git', 'HEAD');
  await Promise.all([
    realDirectory(root, 'Windows elevation launcher home'),
    realDirectory(path.join(root, 'state'), 'Windows elevation launcher state directory'),
    containedFile(exactRunner.root, exactRunner.launcher, 'Windows elevation launcher fixed runner CLI'),
    containedFile(exactRunner.root, source, 'Windows elevation launcher source'),
    containedFile(exactRunner.root, manifest, 'Windows elevation launcher manifest'),
    containedFile(exactRunner.root, headFile, 'Windows elevation launcher runner head'),
    realFile(node, 'Windows elevation launcher Node executable'),
  ]);
  if (String(await readFile(headFile, 'utf8')).trim().toLowerCase() !== exactRunner.head) {
    throw new Error('Windows elevation launcher runner head changed');
  }
  const [nodeSha256, launcherSha256, sourceSha256, manifestSha256] = await Promise.all([
    sha256File(node), sha256File(exactRunner.launcher), sha256File(source), sha256File(manifest),
  ]);
  const bindingValue = Object.freeze({
    home: root,
    node,
    nodeSha256,
    launcher: exactRunner.launcher,
    launcherSha256,
    runnerHead: exactRunner.head,
  });
  const bindingDigest = sha256Bytes(Buffer.from([
    BINDING_PROTOCOL,
    bindingValue.home,
    bindingValue.node,
    bindingValue.nodeSha256,
    bindingValue.launcher,
    bindingValue.launcherSha256,
    bindingValue.runnerHead,
  ].join('\0'), 'utf8'));
  const subjectDigest = sha256Bytes(Buffer.from([
    PROTOCOL,
    bindingDigest,
    sourceSha256,
    manifestSha256,
  ].join('\0'), 'utf8'));
  return Object.freeze({
    ...bindingValue,
    bindingDigest,
    subjectDigest,
    source,
    sourceSha256,
    manifest,
    manifestSha256,
  });
}

function launcherPaths(home, subjectDigest) {
  const state = path.join(home, 'state');
  const parent = path.join(state, DIRECTORY);
  const directory = path.join(parent, subjectDigest);
  return Object.freeze({
    state,
    parent,
    directory,
    executable: path.join(directory, EXECUTABLE),
    receipt: path.join(directory, RECEIPT),
  });
}

function normalizeReceipt(raw, expected) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Windows elevation launcher receipt is invalid');
  const allowed = new Set(['protocol', 'subjectDigest', 'bindingDigest', 'sourceSha256', 'manifestSha256', 'binarySha256', 'binarySize', 'fileDescription', 'purpose', 'executionLevel', 'uiAccess']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError('Windows elevation launcher receipt contains an unknown field');
  if (raw.protocol !== RECEIPT_PROTOCOL || raw.subjectDigest !== expected.subjectDigest || raw.bindingDigest !== expected.bindingDigest
      || raw.sourceSha256 !== expected.sourceSha256 || raw.manifestSha256 !== expected.manifestSha256
      || typeof raw.binarySha256 !== 'string' || !DIGEST.test(raw.binarySha256)
      || !Number.isSafeInteger(raw.binarySize) || raw.binarySize < 1 || raw.binarySize > MAX_BINARY_BYTES
      || raw.fileDescription !== FILE_DESCRIPTION || raw.purpose !== PURPOSE
      || raw.executionLevel !== 'asInvoker' || raw.uiAccess !== false) {
    throw new TypeError('Windows elevation launcher receipt identity is invalid');
  }
  return Object.freeze({ ...raw });
}

async function inspectPrepared(expected) {
  const locations = launcherPaths(expected.home, expected.subjectDigest);
  await Promise.all([
    realDirectory(locations.parent, 'Windows elevation launcher parent'),
    realDirectory(locations.directory, 'Windows elevation launcher directory'),
    realFile(locations.executable, 'Windows elevation launcher executable', { maximumBytes: MAX_BINARY_BYTES }),
    realFile(locations.receipt, 'Windows elevation launcher receipt', { maximumBytes: 16 * 1024 }),
  ]);
  const receipt = normalizeReceipt(JSON.parse(await readFile(locations.receipt, 'utf8')), expected);
  const executable = await realFile(locations.executable, 'Windows elevation launcher executable', { maximumBytes: MAX_BINARY_BYTES });
  if (executable.size !== receipt.binarySize || await sha256File(executable.file) !== receipt.binarySha256) {
    throw new Error('Windows elevation launcher executable identity changed');
  }
  return Object.freeze({
    protocol: PROTOCOL,
    subjectDigest: expected.subjectDigest,
    bindingDigest: expected.bindingDigest,
    executable: executable.file,
    fileDescription: FILE_DESCRIPTION,
    purpose: PURPOSE,
    input: Object.freeze({
      protocol: INPUT_PROTOCOL,
      home: expected.home,
      node: expected.node,
      nodeSha256: expected.nodeSha256,
      launcher: expected.launcher,
      launcherSha256: expected.launcherSha256,
      runnerHead: expected.runnerHead,
      bindingDigest: expected.bindingDigest,
    }),
  });
}

export async function resolveWindowsLifecycleAuthorityElevationLauncher(options = {}) {
  const expected = await binding(options);
  return inspectPrepared(expected);
}

export async function prepareWindowsLifecycleAuthorityElevationLauncher({
  home,
  runner,
  platform = process.platform,
  nodeExecutable = process.execPath,
  invoke = invokeCompileCommand,
} = {}) {
  if (platform !== 'win32') return Object.freeze({ protocol: PROTOCOL, prepared: false, required: false, launcher: null });
  if (typeof invoke !== 'function') throw new TypeError('Windows elevation launcher compile port is invalid');
  const expected = await binding({ home, runner, nodeExecutable });
  try {
    const launcher = await inspectPrepared(expected);
    return Object.freeze({ protocol: PROTOCOL, prepared: true, required: true, changed: false, launcher });
  } catch {}

  const locations = launcherPaths(expected.home, expected.subjectDigest);
  await mkdir(locations.parent, { recursive: true, mode: 0o700 });
  await realDirectory(locations.parent, 'Windows elevation launcher parent');
  const staging = path.join(locations.parent, `.stage-${randomUUID()}`);
  if (!pathWithin(locations.parent, staging)) throw new Error('Windows elevation launcher staging escaped its parent');
  await mkdir(staging, { mode: 0o700 });
  const output = path.join(staging, EXECUTABLE);
  const receiptFile = path.join(staging, RECEIPT);
  try {
    const compiled = await invoke({
      executable: 'powershell.exe',
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript(COMPILE_SCRIPT)],
      input: JSON.stringify({ source: expected.source, manifest: expected.manifest, output }),
      timeoutMs: COMPILE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      environment: process.env,
    });
    if (compiled?.exitCode !== 0 || compiled?.timedOut === true || compiled?.aborted === true || compiled?.outputTruncated === true) {
      throw new Error(`Windows elevation launcher compilation failed: ${String(compiled?.stderr || compiled?.stdout || 'unknown').trim().slice(0, 2048)}`);
    }
    let metadata;
    try { metadata = JSON.parse(String(compiled.stdout ?? '').trim()); }
    catch { metadata = null; }
    const binary = await realFile(output, 'Windows elevation launcher compiled executable', { maximumBytes: MAX_BINARY_BYTES });
    if (!metadata || metadata.fileDescription !== FILE_DESCRIPTION || metadata.productName !== 'DevBridge Protected Setup' || metadata.length !== binary.size) {
      throw new Error('Windows elevation launcher compiled metadata is invalid');
    }
    const receipt = normalizeReceipt({
      protocol: RECEIPT_PROTOCOL,
      subjectDigest: expected.subjectDigest,
      bindingDigest: expected.bindingDigest,
      sourceSha256: expected.sourceSha256,
      manifestSha256: expected.manifestSha256,
      binarySha256: await sha256File(binary.file),
      binarySize: binary.size,
      fileDescription: FILE_DESCRIPTION,
      purpose: PURPOSE,
      executionLevel: 'asInvoker',
      uiAccess: false,
    }, expected);
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try { await rename(staging, locations.directory); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
      await rm(staging, { recursive: true, force: true });
    }
    const launcher = await inspectPrepared(expected);
    return Object.freeze({ protocol: PROTOCOL, prepared: true, required: true, changed: true, launcher });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function windowsLifecycleAuthorityElevationPurpose() {
  return PURPOSE;
}

export { INPUT_PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_ELEVATION_INPUT_PROTOCOL };
