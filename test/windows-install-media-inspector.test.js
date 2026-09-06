import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WindowsInstallMediaInspector,
  normalizeWindowsInstallMediaInventory,
} from '../src/runtime/image-sources/windows-install-media-inspector.js';
import { invokeCommand } from '../src/runtime/command-invocation.js';

function success(value) {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(value), stderr: '' };
}

function observed(overrides = {}) {
  return {
    ok: true,
    container: 'wim',
    images: [{
      index: 6,
      name: 'Windows 11 Pro',
      edition: 'Professional',
      architecture: 'x64',
      version: '10.0.26100.1',
      build: 26100,
      installationType: 'Client',
      languages: ['en-US'],
      defaultLanguage: 'en-US',
    }],
    ...overrides,
  };
}

test('Windows media inspector measures an owned ISO and returns bounded exact image metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-media-inspect-'));
  try {
    const sourceRoot = path.join(root, 'sources');
    await mkdir(sourceRoot);
    const location = path.join(sourceRoot, 'windows.iso');
    const bytes = Buffer.from('exact-owned-media');
    await writeFile(location, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const calls = [];
    const inspector = new WindowsInstallMediaInspector({
      sourceRoot,
      platform: 'win32',
      async invoke(request) { calls.push(request); return success(observed()); },
    });
    const result = await inspector.inspect({ location, expectedSha256: sha256, index: 6 });
    assert.equal(result.protocol, 'devbridge/windows-install-media-observation-v1');
    assert.deepEqual(result.media, { name: 'windows.iso', bytes: bytes.length, sha256 });
    assert.equal(result.image.architecture, 'amd64');
    assert.equal(result.image.edition, 'Professional');
    assert.deepEqual(result.image.languages, ['en-US']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'powershell.exe');
    assert.equal(JSON.parse(calls[0].input).index, 6);
    const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
    assert.match(script, /Mount-DiskImage/u);
    assert.match(script, /WIMGetImageInformation/u);
    assert.match(script, /QueryAccess = 0, OpenExisting = 3/u);
    assert.doesNotMatch(script, /Get-WindowsImage|Import-Module Dism/u);
    assert.match(script, /Dismount-DiskImage/u);
    assert.match(script, /finally/u);
    assert.match(script, /if \(\$null -eq \$disk[^}]+Mount-DiskImage[^}]+\$shouldDismount = \$true\s*\}/su);
    assert.doesNotMatch(script, /\}\s*\$shouldDismount = \$true/u);
    assert.doesNotMatch(script, /Hyper-V|GitHub|repository|product.?key/iu);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows media inventory discovers every bounded image before local approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-media-inventory-'));
  try {
    const sourceRoot = path.join(root, 'sources');
    await mkdir(sourceRoot);
    const location = path.join(sourceRoot, 'windows.iso');
    const bytes = Buffer.from('discovery-media');
    await writeFile(location, bytes);
    const calls = [];
    const second = { ...observed().images[0], index: 1, name: 'Windows 11 Home', edition: 'Core' };
    const inspector = new WindowsInstallMediaInspector({
      sourceRoot,
      platform: 'win32',
      async invoke(request) { calls.push(request); return success(observed({ images: [observed().images[0], second] })); },
    });
    const result = await inspector.inventory({ location });
    assert.equal(result.protocol, 'devbridge/windows-install-media-inventory-v1');
    assert.equal(result.media.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(result.images.map(({ index, edition }) => [index, edition]), [[1, 'Core'], [6, 'Professional']]);
    assert.equal(JSON.parse(calls[0].input).index, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native PowerShell media inspection validates containers, bounded XML and exact image selection', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-media-shell-'));
  try {
    const location = path.join(root, 'windows.iso');
    await writeFile(location, 'media-shell-fixture');
    const xml = "<WIM><IMAGE INDEX='6'><NAME>Windows 11 Pro</NAME><WINDOWS><ARCH>9</ARCH><EDITIONID>Professional</EDITIONID><INSTALLATIONTYPE>Client</INSTALLATIONTYPE><LANGUAGES><LANGUAGE>en-US</LANGUAGE><DEFAULT>en-US</DEFAULT></LANGUAGES><VERSION><MAJOR>10</MAJOR><MINOR>0</MINOR><BUILD>26200</BUILD><SPBUILD>1</SPBUILD></VERSION></WINDOWS></IMAGE></WIM>";
    // Replace only platform effects. Run the complete generated script in the
    // actual shell so collection enumeration and JSON conversion remain native.
    const platform = String.raw`
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
public static class DevBridgeWimMetadata {
  public static string Read(string path) {
    string value = System.Environment.GetEnvironmentVariable("DEVBRIDGE_TEST_WIM_XML");
    return value == "oversize" ? new string('x', 1048577) : value;
  }
}
'@
function Add-Type {}
function Import-Module {}
function Get-DiskImage { return $null }
function Mount-DiskImage { return @{ Attached = $true } }
function Get-Volume { return [pscustomobject]@{ DriveLetter = 'C' } }
function Dismount-DiskImage { [Console]::Error.WriteLine('fixture-dismounted') }
function Test-Path {
  param($LiteralPath, $PathType)
  if ($LiteralPath -match 'sources\\install\.(wim|esd)$') { return $data.fixtureContainers -contains $Matches[1] }
  return $true
}
`;
    for (const fixture of [
      { containers: ['wim'] }, { containers: ['esd'] }, { containers: ['wim'], index: 6 },
      { containers: [], error: /inspection-failed/u },
      { containers: ['wim', 'esd'], error: /inspection-failed/u },
      { index: 1, error: /inspection-failed/u },
      { xml: '<WIM>', error: /inspection-failed/u },
      { xml: '<!DOCTYPE WIM [<!ENTITY x "expanded">]>' + xml, error: /inspection-failed/u },
      { xml: 'oversize', error: /inspection-failed/u },
      { xml: xml.replace('</WIM>', xml.slice(5)), error: /duplicate/u },
    ]) {
      const containers = fixture.containers ?? ['wim'];
      let nativeResult;
      const inspector = new WindowsInstallMediaInspector({ sourceRoot: root, async invoke(request) {
        const args = [...request.arguments];
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        args[args.length - 1] = Buffer.from(platform + script, 'utf16le').toString('base64');
        nativeResult = await invokeCommand({ ...request, arguments: args,
          input: JSON.stringify({ ...JSON.parse(request.input), fixtureContainers: containers }),
          environment: { ...process.env, DEVBRIDGE_TEST_WIM_XML: fixture.xml ?? xml },
        });
        return nativeResult;
      } });
      const observe = () => fixture.index == null ? inspector.inventory({ location })
        : inspector.inspect({ location, index: fixture.index, expectedSha256: createHash('sha256').update('media-shell-fixture').digest('hex') });
      if (!fixture.error) {
        const result = await observe();
        const images = result.images ?? [result.image];
        assert.equal(images.length, 1);
        assert.equal(images[0].container, containers[0]);
        assert.equal(images[0].index, 6);
        assert.deepEqual(images[0].languages, ['en-US']);
      } else {
        await assert.rejects(observe, fixture.error);
      }
      assert.equal(nativeResult.exitCode, 0, nativeResult.stderr);
      assert.equal(nativeResult.timedOut, false);
      assert.equal(nativeResult.stderr.trim(), 'fixture-dismounted');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('public Windows media inventory normalization is closed and deterministic', () => {
  const inventory = normalizeWindowsInstallMediaInventory({
    protocol: 'devbridge/windows-install-media-inventory-v1',
    media: { name: 'Windows.iso', bytes: 100, sha256: 'a'.repeat(64) },
    images: [
      { ...observed().images[0], container: 'wim', index: 6 },
      { ...observed().images[0], container: 'wim', index: 1, edition: 'Core', name: 'Windows 11 Home' },
    ],
  });
  assert.deepEqual(inventory.images.map((entry) => entry.index), [1, 6]);
  assert.throws(() => normalizeWindowsInstallMediaInventory({ ...inventory, location: 'C:\\private\\Windows.iso' }), /location is not allowed/u);
  assert.throws(() => normalizeWindowsInstallMediaInventory({ ...inventory, media: { ...inventory.media, sha256: 'A'.repeat(64) } }), /sha256 is invalid/u);
});

test('Windows media inventory platform script is accepted by Windows PowerShell without execution', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-media-parser-'));
  try {
    const sourceRoot = path.join(root, 'sources');
    await mkdir(sourceRoot);
    const location = path.join(sourceRoot, 'windows.iso');
    await writeFile(location, 'parser-source');
    let request;
    const inspector = new WindowsInstallMediaInspector({
      sourceRoot,
      platform: 'win32',
      async invoke(value) { request = value; return success(observed()); },
    });
    await inspector.inventory({ location });
    const source = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
    const parser = "$ErrorActionPreference='Stop'; $source=[Console]::In.ReadToEnd(); $null=[ScriptBlock]::Create($source); @{ valid=$true } | ConvertTo-Json -Compress";
    const result = await invokeCommand({
      executable: 'powershell.exe',
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')],
      input: source,
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { valid: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows media inspector rejects digest mismatch and source escape before invoking the platform edge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-media-boundary-'));
  try {
    const sourceRoot = path.join(root, 'sources');
    await mkdir(sourceRoot);
    const inside = path.join(sourceRoot, 'inside.iso');
    const outside = path.join(root, 'outside.iso');
    await writeFile(inside, 'inside');
    await writeFile(outside, 'outside');
    let calls = 0;
    const inspector = new WindowsInstallMediaInspector({
      sourceRoot, platform: 'win32', invoke: async () => { calls += 1; return success(observed()); },
    });
    await assert.rejects(() => inspector.inspect({ location: inside, expectedSha256: 'f'.repeat(64), index: 6 }), /digest does not match/u);
    await assert.rejects(() => inspector.inspect({ location: outside, expectedSha256: 'f'.repeat(64), index: 6 }), /outside the owned source root/u);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows media inspector fails closed on unsupported hosts and malformed platform observations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-media-platform-'));
  try {
    const sourceRoot = path.join(root, 'sources');
    await mkdir(sourceRoot);
    const location = path.join(sourceRoot, 'windows.iso');
    const bytes = Buffer.from('source');
    await writeFile(location, bytes);
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    let calls = 0;
    const unsupported = new WindowsInstallMediaInspector({
      sourceRoot, platform: 'linux', invoke: async () => { calls += 1; return success(observed()); },
    });
    await assert.rejects(() => unsupported.inspect({ location, expectedSha256, index: 6 }), /requires a Windows host/u);
    assert.equal(calls, 0);

    const malformed = new WindowsInstallMediaInspector({
      sourceRoot, platform: 'win32', invoke: async () => success(observed({ container: 'zip' })),
    });
    await assert.rejects(() => malformed.inspect({ location, expectedSha256, index: 6 }), /container is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows media inspector does not expose caller paths from failed platform output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-media-errors-'));
  try {
    const sourceRoot = path.join(root, 'sources');
    await mkdir(sourceRoot);
    const location = path.join(sourceRoot, 'private-name.iso');
    const bytes = Buffer.from('source');
    await writeFile(location, bytes);
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    const inspector = new WindowsInstallMediaInspector({
      sourceRoot,
      platform: 'win32',
      invoke: async () => ({ ...success({}), exitCode: 1, stderr: `failure at ${location}` }),
    });
    await assert.rejects(
      () => inspector.inspect({ location, expectedSha256, index: 6 }),
      (error) => error.message === 'Windows media inspection operation failed' && !error.message.includes(location),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
