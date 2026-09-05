import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, realpath, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reobserveExactFile } from '../immutable-object-acquisition-evidence.js';
import { sameFilesystemIdentity, sameObservedFilesystemIdentity } from '../local-filesystem-identity.js';

const POWERSHELL = 'powershell.exe';
const COMMAND_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const VOLUME = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const SEGMENT = /^[A-Za-z0-9_$+(). -]{1,96}$/u;
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const CREATE_MEDIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (-not $data.files -and -not [System.IO.Directory]::Exists([string]$data.source)) { throw 'media source directory is absent' }
if ([System.IO.File]::Exists([string]$data.destination)) { throw 'media destination already exists' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;

namespace DevBridge {
  [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
  public sealed class VerifiedInput : IStream, IDisposable {
    private FileStream file;
    public VerifiedInput(string location, long size, string digest) {
      file = new FileStream(location, FileMode.Open, FileAccess.Read, FileShare.Read);
      try {
        if (file.Length != size) throw new IOException("input size changed");
        using (SHA256 hash = SHA256.Create()) {
          string actual = BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
          if (actual != digest || file.Length != size) throw new IOException("input digest changed");
        }
        file.Position = 0;
      } catch { file.Dispose(); file = null; throw; }
    }
    public void Dispose() { if (file != null) { file.Dispose(); file = null; } }
    public void Read(byte[] buffer, int count, IntPtr read) { int n = file.Read(buffer, 0, count); if (read != IntPtr.Zero) Marshal.WriteInt32(read, n); }
    public void Seek(long offset, int origin, IntPtr position) { long n = file.Seek(offset, (SeekOrigin)origin); if (position != IntPtr.Zero) Marshal.WriteInt64(position, n); }
    public void Stat(out System.Runtime.InteropServices.ComTypes.STATSTG stat, int flags) { stat = new System.Runtime.InteropServices.ComTypes.STATSTG(); stat.type = 2; stat.cbSize = file.Length; }
    public void Write(byte[] buffer, int count, IntPtr written) { throw new NotSupportedException(); }
    public void SetSize(long size) { throw new NotSupportedException(); }
    public void CopyTo(IStream target, long count, IntPtr read, IntPtr written) { throw new NotSupportedException(); }
    public void Commit(int flags) { }
    public void Revert() { throw new NotSupportedException(); }
    public void LockRegion(long offset, long count, int type) { throw new NotSupportedException(); }
    public void UnlockRegion(long offset, long count, int type) { throw new NotSupportedException(); }
    public void Clone(out IStream clone) { clone = null; throw new NotSupportedException(); }
  }
  public static class ImapiStreamCopy {
    public static void ToFile(object source, string destination, long maximumBytes) {
      IStream stream = (IStream)source;
      bool created = false;
      try {
        using (FileStream file = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
          created = true;
          byte[] buffer = new byte[32768];
          IntPtr readPointer = Marshal.AllocCoTaskMem(sizeof(int));
          try {
            while (true) {
              Marshal.WriteInt32(readPointer, 0);
              stream.Read(buffer, buffer.Length, readPointer);
              int read = Marshal.ReadInt32(readPointer);
              if (read <= 0) break;
              if (file.Position > maximumBytes - read) throw new IOException("media exceeds byte budget");
              file.Write(buffer, 0, read);
            }
            file.Flush(true);
          } finally {
            Marshal.FreeCoTaskMem(readPointer);
          }
        }
      } catch {
        if (created && File.Exists(destination)) File.Delete(destination);
        throw;
      }
    }
  }
}
'@
$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$inputs = New-Object 'System.Collections.Generic.List[System.IDisposable]'
$result = $null
$stream = $null
try {
  if ($data.files) { $image.WorkingDirectory = [string]$data.workingDirectory; $image.StageFiles = $false }
  $image.FileSystemsToCreate = $(if ($data.files) { [int]$data.fileSystems } else { 3 })
  $image.VolumeName = [string]$data.volumeLabel
  $maximumBytes = $(if ($data.files) { [long]$data.maximumImageBytes } else { [long]681574400 })
  if ($data.files) {
    $image.FreeMediaBlocks = [int][Math]::Floor($maximumBytes / 2048)
    $image.UDFRevision = 0x102
    $directories = @{}
    foreach ($entry in $data.files) {
      $segments = ([string]$entry.path).Split('/')
      $relative = ''
      for ($i = 0; $i -lt $segments.Length - 1; $i++) {
        $relative = $(if ($relative) { $relative + '/' + $segments[$i] } else { $segments[$i] })
        if (-not $directories.ContainsKey($relative)) { $image.Root.AddDirectory($relative); $directories[$relative] = $true }
      }
      $inputStream = New-Object DevBridge.VerifiedInput([string]$entry.source.location, [long]$entry.source.size, [string]$entry.source.sha256)
      $inputs.Add($inputStream)
      $image.Root.AddFile([string]$entry.path, $inputStream)
    }
  } else { $image.Root.AddTree([string]$data.source, $false) }
  $result = $image.CreateResultImage()
  $stream = $result.ImageStream
  [DevBridge.ImapiStreamCopy]::ToFile($stream, [string]$data.destination, $maximumBytes)
  @{ created = $true } | ConvertTo-Json -Compress
} finally {
  try {
    if ($null -ne $stream -and [Runtime.InteropServices.Marshal]::IsComObject($stream)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($stream) }
  } finally {
    try {
      if ($null -ne $result -and [Runtime.InteropServices.Marshal]::IsComObject($result)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($result) }
    } finally {
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($image) }
      finally { foreach ($inputStream in $inputs) { $inputStream.Dispose() } }
    }
  }
}
`;

function encodedScript(value) { return Buffer.from(value, 'utf16le').toString('base64'); }

function mediaPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) throw new TypeError('data media file path is invalid');
  const segments = value.split('/');
  if (segments.some((segment) => !SEGMENT.test(segment) || segment.endsWith('.') || segment.endsWith(' ') || RESERVED.test(segment))) throw new TypeError('data media file path is invalid');
  return value;
}

function normalizeFiles(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILES) throw new TypeError('data media files are invalid');
  const seen = new Set();
  let totalBytes = 0;
  return raw.map((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) throw new TypeError(`data media files[${index}] is invalid`);
    for (const key of Object.keys(rawEntry)) if (!['path', 'content'].includes(key)) throw new TypeError(`data media files[${index}].${key} is not allowed`);
    const selectedPath = mediaPath(rawEntry.path);
    const collisionKey = selectedPath.toLowerCase();
    if (seen.has(collisionKey)) throw new TypeError(`data media files[${index}] duplicates another entry`);
    seen.add(collisionKey);
    if (typeof rawEntry.content !== 'string' || rawEntry.content.length === 0 || rawEntry.content.includes('\0')) throw new TypeError(`data media files[${index}].content is invalid`);
    const bytes = Buffer.byteLength(rawEntry.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new TypeError(`data media files[${index}].content is invalid`);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new TypeError('data media file bytes exceed the total bound');
    return { path: selectedPath, content: rawEntry.content };
  });
}

async function realDirectory(location, label) {
  const info = await lstat(location);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function realFile(location, label) {
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real regular file`);
  return info;
}

async function sha256File(location, signal) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(location, { signal });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function parseResult(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) throw new Error('data media creation failed');
  let parsed;
  try { parsed = JSON.parse(String(result.stdout ?? '')); } catch { throw new Error('data media creation returned invalid structured output'); }
  if (parsed?.created !== true) throw new Error('data media creation did not confirm completion');
}

function exactFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${label}.${key} is unsupported`);
  return value;
}

function exactFileRequest(raw) {
  const request = exactFields(raw, ['root', 'destination', 'volumeLabel', 'files', 'maximumImageBytes', 'timeoutMs', 'signal'], 'exact-file media');
  if (typeof request.root !== 'string' || !path.isAbsolute(request.root) || typeof request.destination !== 'string' || !path.isAbsolute(request.destination)) throw new TypeError('exact-file media requires absolute local roots');
  if (typeof request.volumeLabel !== 'string' || !VOLUME.test(request.volumeLabel)) throw new TypeError('exact-file media volume label is invalid');
  // UDF media reserves anchor/volume structures; the supported image budget
  // starts at 1 MiB and never exceeds IMAPI's documented 2 TiB UDF ceiling.
  if (!Number.isSafeInteger(request.maximumImageBytes) || request.maximumImageBytes < 1024 * 1024 || request.maximumImageBytes > 2 ** 41) throw new TypeError('exact-file media byte budget is invalid');
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 300000) throw new TypeError('exact-file media duration budget is invalid');
  if (!Array.isArray(request.files) || !request.files.length) throw new TypeError('exact-file media files are invalid');
  const names = new Set();
  const directories = new Set();
  let total = 0;
  const files = request.files.map((rawFile) => {
    const file = exactFields(rawFile, ['path', 'source'], 'exact-file media file');
    if (typeof file.path !== 'string' || !file.path.length || file.path.length > 1024) throw new TypeError('exact-file media path is invalid');
    const segments = file.path.split('/');
    if (segments.some((segment) => !/^[A-Za-z0-9_$+(). ~%-]{1,255}$/u.test(segment) || ['.', '..'].includes(segment) || segment.endsWith('.') || segment.endsWith(' ') || RESERVED.test(segment))) throw new TypeError('exact-file media path is invalid');
    const key = file.path.toLowerCase();
    if (names.has(key) || directories.has(key)) throw new TypeError('exact-file media path collision');
    for (let i = 1; i < segments.length; i++) {
      const directory = segments.slice(0, i).join('/').toLowerCase();
      if (names.has(directory)) throw new TypeError('exact-file media directory collision');
      directories.add(directory);
    }
    names.add(key);
    const source = exactFields(file.source, ['location', 'size', 'sha256'], 'exact-file media source');
    if (typeof source.location !== 'string' || !path.isAbsolute(source.location) || /[\u0000-\u001f\u007f]/u.test(source.location)
        || !Number.isSafeInteger(source.size) || source.size < 1 || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256)) throw new TypeError('exact-file media source identity is invalid');
    if (source.size > request.maximumImageBytes - total) throw new TypeError('exact-file media content exceeds byte budget');
    total += source.size;
    return Object.freeze({ path: file.path, source: Object.freeze({ ...source }) });
  });
  return { ...request, files: Object.freeze(files) };
}

async function unchangedDirectory(location, expected) {
  const observed = await lstat(location, { bigint: true });
  if (!observed.isDirectory() || observed.isSymbolicLink() || !sameObservedFilesystemIdentity(expected, observed)
      || !await sameFilesystemIdentity(location, await realpath(location))) throw new Error('exact-file media directory identity changed');
}

async function requirePlainTree(directory) {
  for (const name of await readdir(directory)) {
    const location = path.join(directory, name);
    const entry = await lstat(location);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || (entry.isFile() && entry.nlink !== 1)) throw new Error('exact-file media retained indirect native scratch');
    if (entry.isDirectory()) await requirePlainTree(location);
  }
}

export class WindowsImapiDataMediaWriter {
  #invoke;

  constructor({ invoke } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
    this.#invoke = invoke;
  }

  async createFiles(raw = {}) {
    const request = exactFileRequest(raw);
    const deadline = Date.now() + request.timeoutMs;
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]) : AbortSignal.timeout(request.timeoutMs);
    signal.throwIfAborted();
    const root = path.resolve(request.root);
    const output = path.resolve(request.destination);
    if (path.dirname(output) !== root) throw new Error('exact-file media destination must be a direct child of its root');
    await realDirectory(root, 'exact-file media root');
    const rootIdentity = await lstat(root, { bigint: true });
    await unchangedDirectory(root, rootIdentity);
    try { await lstat(output); throw new Error('exact-file media destination already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const identities = [];
    for (const file of request.files) {
      await reobserveExactFile({ ...file.source, signal });
      identities.push(await lstat(file.source.location, { bigint: true }));
    }
    signal.throwIfAborted();
    await unchangedDirectory(root, rootIdentity);
    const staging = path.join(root, `.media-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    const stagingIdentity = await lstat(staging, { bigint: true });
    const pending = path.join(staging, 'image.iso');
    const workingDirectory = path.join(staging, 'native');
    let workingIdentity = null;
    try {
      await mkdir(workingDirectory, { mode: 0o700 });
      workingIdentity = await lstat(workingDirectory, { bigint: true });
      signal.throwIfAborted();
      parseResult(await this.#invoke({
        executable: POWERSHELL,
        arguments: [...COMMAND_ARGS, encodedScript(CREATE_MEDIA_SCRIPT)],
        input: JSON.stringify({ files: request.files, destination: pending, workingDirectory, volumeLabel: request.volumeLabel, fileSystems: 4, maximumImageBytes: request.maximumImageBytes }),
        timeoutMs: Math.max(100, deadline - Date.now()), signal, maxOutputBytes: 256 * 1024,
      }));
      signal.throwIfAborted();
      for (let index = 0; index < request.files.length; index++) {
        const source = request.files[index].source;
        await reobserveExactFile({ ...source, signal });
        const current = await lstat(source.location, { bigint: true });
        if (!sameObservedFilesystemIdentity(current, identities[index]) || current.ctimeNs !== identities[index].ctimeNs || current.mtimeNs !== identities[index].mtimeNs) throw new Error('exact-file media input identity changed');
      }
      await unchangedDirectory(root, rootIdentity);
      await unchangedDirectory(staging, stagingIdentity);
      const info = await lstat(pending, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 1n || info.size > BigInt(request.maximumImageBytes)) throw new Error('exact-file media output shape is invalid');
      const sha256 = await sha256File(pending, signal);
      const after = await lstat(pending, { bigint: true });
      if (!sameObservedFilesystemIdentity(info, after) || after.ctimeNs !== info.ctimeNs || after.mtimeNs !== info.mtimeNs || after.size !== info.size) throw new Error('exact-file media output changed');
      signal.throwIfAborted();
      await link(pending, output); // Same-volume create-only publication; never replace a foreign output.
      await unlink(pending);
      const committed = await lstat(output, { bigint: true });
      if (!committed.isFile() || committed.isSymbolicLink() || committed.nlink !== 1n || !sameObservedFilesystemIdentity(info, committed) || committed.size !== info.size || committed.mtimeNs !== info.mtimeNs) throw new Error('exact-file media publication identity changed');
      await unchangedDirectory(root, rootIdentity);
      return Object.freeze({ location: output, bytes: Number(info.size), sha256, volumeLabel: request.volumeLabel, fileCount: request.files.length, fileSystem: 'udf' });
    } finally {
      await unchangedDirectory(root, rootIdentity);
      await unchangedDirectory(staging, stagingIdentity);
      if (workingIdentity) {
        await unchangedDirectory(workingDirectory, workingIdentity);
        await requirePlainTree(workingDirectory);
      } else {
        try { await lstat(workingDirectory); throw new Error('exact-file media retained ambiguous native scratch'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const names = await readdir(staging);
      if (names.some((name) => !['image.iso', 'native'].includes(name))) throw new Error('exact-file media retained unexpected staging contents');
      if (names.includes('image.iso')) {
        const entry = await lstat(pending);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('exact-file media retained substituted staging output');
      }
      await rm(staging, { recursive: true });
      // A successfully published result belongs to the caller even when later
      // cleanup fails; never erase it as an implicit retry/repair operation.
    }
  }

  async create({ root, destination, volumeLabel, files } = {}) {
    if (typeof root !== 'string' || typeof destination !== 'string') throw new TypeError('data media root and destination are required');
    if (typeof volumeLabel !== 'string' || !VOLUME.test(volumeLabel)) throw new TypeError('data media volumeLabel is invalid');
    const entries = normalizeFiles(files);
    const ownedRoot = path.resolve(root);
    await realDirectory(ownedRoot, 'data media root');
    const output = path.resolve(destination);
    if (path.dirname(output) !== ownedRoot) throw new Error('data media destination must stay inside the owned root as a direct child');
    try { await lstat(output); throw new Error('data media destination already exists'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }

    const staging = path.join(ownedRoot, `.media-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    let completed = false;
    try {
      for (const entry of entries) {
        const location = path.join(staging, ...entry.path.split('/'));
        await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
        await writeFile(location, entry.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
      parseResult(await this.#invoke({
        executable: POWERSHELL,
        arguments: [...COMMAND_ARGS, encodedScript(CREATE_MEDIA_SCRIPT)],
        input: JSON.stringify({ source: staging, destination: output, volumeLabel }),
        timeoutMs: 120_000,
        maxOutputBytes: 256 * 1024,
      }));
      const info = await realFile(output, 'data media image');
      const result = { location: output, bytes: info.size, sha256: await sha256File(output), volumeLabel, fileCount: entries.length };
      completed = true;
      return result;
    } finally {
      await rm(staging, { recursive: true, force: true });
      if (!completed) await rm(output, { force: true });
    }
  }
}

export function createWindowsImapiDataMediaWriter(options) {
  return new WindowsImapiDataMediaWriter(options);
}
