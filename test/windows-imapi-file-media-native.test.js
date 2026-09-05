import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { invokeCommand } from '../src/runtime/command-invocation.js';
import { WindowsImapiDataMediaWriter } from '../src/runtime/providers/windows-imapi-data-media.js';

const READ_MEDIA = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$disk = $null
try {
  $disk = Mount-DiskImage -ImagePath ([string]$data.location) -StorageType ISO -Access ReadOnly -NoDriveLetter -PassThru
  $volumes = @($disk | Get-Volume)
  if ($volumes.Count -ne 1) { throw 'media volume identity is ambiguous' }
  $volume = $volumes[0]
  $result = @()
  foreach ($entry in $data.files) {
    $location = [IO.Path]::Combine([string]$volume.UniqueId, ([string]$entry.path).Replace('/', '\'))
    $file = [IO.File]::OpenRead($location)
    try {
      $hash = [Security.Cryptography.SHA256]::Create()
      try { $digest = [BitConverter]::ToString($hash.ComputeHash($file)).Replace('-', '').ToLowerInvariant() }
      finally { $hash.Dispose() }
      $result += @{ path=[string]$entry.path; size=$file.Length; sha256=$digest }
    } finally { $file.Dispose() }
  }
  $nativeVolumes = @(Get-CimInstance Win32_Volume | Where-Object { $_.DeviceID -eq [string]$volume.UniqueId })
  if ($nativeVolumes.Count -ne 1) { throw 'native filesystem observation is ambiguous' }
  @{ fileSystem=[string]$nativeVolumes[0].FileSystem; label=[string]$volume.FileSystemLabel; files=$result } | ConvertTo-Json -Depth 5 -Compress
} finally {
  if ($null -ne $disk) { [void](Dismount-DiskImage -ImagePath ([string]$data.location) -ErrorAction Stop) }
}
`;

test('native IMAPI UDF preserves exact binary files and 99-character names', {
  skip: process.platform !== 'win32' || process.env.DEVBRIDGE_IMAPI_NATIVE_TEST !== '1',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-imapi-native-'));
  let safeToRemove = true;
  try {
    const content = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256));
    const source = path.join(root, 'input.bin'); await writeFile(source, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const filePath = `pool/main/n/node-test/${'a'.repeat(95)}.deb`;
    const files = [{ path: filePath, source: { location: source, size: content.length, sha256 } }];
    const media = await new WindowsImapiDataMediaWriter({ invoke: invokeCommand }).createFiles({
      root, destination: path.join(root, 'data.iso'), volumeLabel: 'DB_NATIVE', files,
      maximumImageBytes: 8 * 1024 * 1024, timeoutMs: 120000,
    });
    safeToRemove = false;
    const readback = await invokeCommand({
      executable: 'powershell.exe',
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(READ_MEDIA, 'utf16le').toString('base64')],
      input: JSON.stringify({ location: media.location, files: [{ path: filePath }] }),
      timeoutMs: 60000, maxOutputBytes: 16384,
    });
    assert.equal(readback.exitCode, 0, `native readback/detachment failed: ${readback.stderr}`);
    safeToRemove = true;
    const result = JSON.parse(readback.stdout);
    assert.equal(result.fileSystem, 'UDF');
    assert.equal(result.label, 'DB_NATIVE');
    assert.deepEqual(result.files, [{ path: filePath, size: content.length, sha256 }]);
  } finally {
    if (safeToRemove) await rm(root, { recursive: true, force: true });
    else console.error(`Native media retained for mount-state reconciliation: ${root}`);
  }
});

test('native existing text media remains CDFS with exact seed bytes', {
  skip: process.platform !== 'win32' || process.env.DEVBRIDGE_IMAPI_NATIVE_TEST !== '1',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-imapi-native-text-'));
  let safeToRemove = true;
  try {
    const content = '#cloud-config\n';
    const media = await new WindowsImapiDataMediaWriter({ invoke: invokeCommand }).create({
      root, destination: path.join(root, 'seed.iso'), volumeLabel: 'CIDATA', files: [{ path: 'user-data', content }],
    });
    safeToRemove = false;
    const readback = await invokeCommand({
      executable: 'powershell.exe',
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(READ_MEDIA, 'utf16le').toString('base64')],
      input: JSON.stringify({ location: media.location, files: [{ path: 'user-data' }] }),
      timeoutMs: 60000, maxOutputBytes: 16384,
    });
    assert.equal(readback.exitCode, 0, `native readback/detachment failed: ${readback.stderr}`);
    safeToRemove = true;
    const result = JSON.parse(readback.stdout);
    assert.equal(result.fileSystem, 'CDFS');
    assert.equal(result.label, 'CIDATA');
    assert.deepEqual(result.files, [{ path: 'user-data', size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }]);
  } finally {
    if (safeToRemove) await rm(root, { recursive: true, force: true });
    else console.error(`Native media retained for mount-state reconciliation: ${root}`);
  }
});
