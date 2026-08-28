import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsInstallMediaInspector } from '../src/runtime/image-sources/windows-install-media-inspector.js';
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
    assert.match(script, /Get-WindowsImage/u);
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
