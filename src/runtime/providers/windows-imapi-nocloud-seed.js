import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const POWERSHELL = 'powershell.exe';
const COMMAND_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const MAX_SEED_BYTES = 1024 * 1024;

const CREATE_SEED_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (-not [System.IO.Directory]::Exists([string]$data.source)) { throw 'seed source directory is absent' }
if ([System.IO.File]::Exists([string]$data.destination)) { throw 'seed destination already exists' }
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
$image.VolumeName = 'CIDATA'
$image.Root.AddTree([string]$data.source, $false)
$result = $image.CreateResultImage()
[DevBridge.ImapiStreamCopy]::ToFile($result.ImageStream, [string]$data.destination)
@{ created = $true } | ConvertTo-Json -Compress
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function checkedSeed(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes === 0 || bytes > MAX_SEED_BYTES || value.includes('\0')) throw new Error(`${label} is outside the allowed seed bounds`);
  return value.endsWith('\n') ? value : `${value}\n`;
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

async function realDirectory(location, label) {
  const info = await lstat(location);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function realFile(location, label) {
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real regular file`);
  return info;
}

function parseResult(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    throw new Error((result?.stderr?.trim() || result?.stdout?.trim() || 'seed image creation failed').slice(0, 2048));
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('seed image creation returned invalid structured output'); }
  if (parsed?.created !== true) throw new Error('seed image creation did not confirm completion');
}

export class WindowsImapiNoCloudSeedWriter {
  #invoke;

  constructor({ invoke } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
    this.#invoke = invoke;
  }

  async create({ root, destination, userData, metaData }) {
    if (typeof root !== 'string' || typeof destination !== 'string') throw new TypeError('seed root and destination are required');
    const ownedRoot = path.resolve(root);
    await realDirectory(ownedRoot, 'seed root');
    const output = path.resolve(destination);
    if (output === ownedRoot || !output.startsWith(`${ownedRoot}${path.sep}`)) throw new Error('seed destination must stay inside the owned root');

    const safeUserData = checkedSeed(userData, 'user-data');
    const safeMetaData = checkedSeed(metaData, 'meta-data');
    const staging = path.join(ownedRoot, `.seed-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      await writeFile(path.join(staging, 'user-data'), safeUserData, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await writeFile(path.join(staging, 'meta-data'), safeMetaData, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      parseResult(await this.#invoke({
        executable: POWERSHELL,
        arguments: [...COMMAND_ARGS, encodedScript(CREATE_SEED_SCRIPT)],
        input: JSON.stringify({ source: staging, destination: output }),
        timeoutMs: 120_000,
        maxOutputBytes: 256 * 1024,
      }));
      const info = await realFile(output, 'seed image');
      return { location: output, bytes: info.size, sha256: await sha256File(output), volumeLabel: 'CIDATA' };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export function createWindowsImapiNoCloudSeedWriter(options) {
  return new WindowsImapiNoCloudSeedWriter(options);
}
