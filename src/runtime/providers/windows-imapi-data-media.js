import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
if (-not [System.IO.Directory]::Exists([string]$data.source)) { throw 'media source directory is absent' }
if ([System.IO.File]::Exists([string]$data.destination)) { throw 'media destination already exists' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace DevBridge {
  public static class ImapiStreamCopy {
    public static void ToFile(object source, string destination) {
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
$image.FileSystemsToCreate = 3
$image.VolumeName = [string]$data.volumeLabel
$image.Root.AddTree([string]$data.source, $false)
$result = $image.CreateResultImage()
[DevBridge.ImapiStreamCopy]::ToFile($result.ImageStream, [string]$data.destination)
@{ created = $true } | ConvertTo-Json -Compress
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

async function sha256File(location) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(location);
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

export class WindowsImapiDataMediaWriter {
  #invoke;

  constructor({ invoke } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
    this.#invoke = invoke;
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
