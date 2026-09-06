import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('native bootable copy emits EFI no-emulation with exact boot bytes and detaches on success and failure', {
  skip: process.platform !== 'win32' || process.env.DEVBRIDGE_IMAPI_NATIVE_TEST !== '1',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-imapi-native-boot-'));
  let safeToRemove = true;
  const writer = new WindowsImapiDataMediaWriter({ invoke: invokeCommand });
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  try {
    // 1.44 MiB deliberately triggers IMAPI's automatic floppy-emulation default.
    const boot = Buffer.alloc(1474560, 0x42);
    const location = path.join(root, 'boot.bin'); await writeFile(location, boot);
    const bootSource = { location, size: boot.length, sha256: hash(boot) };
    for (const hasBoot of [true, false]) {
      const source = await writer.createFiles({ root, destination: path.join(root, `source-${hasBoot}.iso`), volumeLabel: 'DB_SOURCE',
        files: [{ path: hasBoot ? 'efi/microsoft/boot/efisys_noprompt.bin' : 'unrelated.bin', source: bootSource }],
        maximumImageBytes: 8 * 1024 ** 2, timeoutMs: 120000 });
      const destination = path.join(root, `copy-${hasBoot}.iso`);
      safeToRemove = false;
      const request = { root, destination, volumeLabel: 'DB_INSTALL', source: { location: source.location, size: source.bytes, sha256: source.sha256 }, maximumImageBytes: 8 * 1024 ** 2, timeoutMs: 120000 };
      if (hasBoot) {
        const media = await writer.createBootableCopy(request);
        const iso = await readFile(media.location);
        let descriptor;
        for (let offset = 16 * 2048; offset < 64 * 2048; offset += 2048) {
          if (iso[offset] === 0 && iso.toString('ascii', offset + 1, offset + 6) === 'CD001') { descriptor = iso.subarray(offset, offset + 2048); break; }
        }
        assert.ok(descriptor);
        const catalog = iso.subarray(descriptor.readUInt32LE(71) * 2048);
        assert.equal(catalog[1], 0xef);
        assert.equal(catalog[32], 0x88);
        assert.equal(catalog[33], 0, 'EFI boot image must not use inferred floppy emulation');
        assert.equal(hash(iso.subarray(catalog.readUInt32LE(40) * 2048, catalog.readUInt32LE(40) * 2048 + boot.length)), bootSource.sha256);
      } else {
        await assert.rejects(writer.createBootableCopy(request), /creation failed/);
        assert.equal((await readdir(root)).includes(path.basename(destination)), false);
      }
      const detached = await invokeCommand({ executable: 'powershell.exe', arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$data=[Console]::In.ReadToEnd() | ConvertFrom-Json; if ((Get-DiskImage -ImagePath $data.location).Attached) { exit 1 }'], input: JSON.stringify({ location: source.location }), timeoutMs: 30000, maxOutputBytes: 16384 });
      assert.equal(detached.exitCode, 0, 'writer must detach its source mount');
      safeToRemove = true;
      assert.equal(hash(await readFile(source.location)), source.sha256);
    }
  } finally {
    if (safeToRemove) await rm(root, { recursive: true, force: true });
    else console.error(`Native media retained for mount-state reconciliation: ${root}`);
  }
});

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
