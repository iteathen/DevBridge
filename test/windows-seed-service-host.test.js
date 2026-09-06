import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WINDOWS_SEED_SERVICE_HOST_SOURCE, windowsSeedServiceHostMaterial } from '../src/runtime/image-builders/windows-seed-service-host.js';
import { invokeCommand } from '../src/runtime/command-invocation.js';

test('guest seed service host binds its local source and limits its process contract', () => {
  const material = windowsSeedServiceHostMaterial();
  assert.equal(Buffer.from(material.sourceBase64, 'base64').toString('utf8'), WINDOWS_SEED_SERVICE_HOST_SOURCE);
  assert.equal(material.sourceSha256, createHash('sha256').update(WINDOWS_SEED_SERVICE_HOST_SOURCE).digest('hex'));
  assert.match(WINDOWS_SEED_SERVICE_HOST_SOURCE, /ServiceBase\.Run/u);
  assert.match(WINDOWS_SEED_SERVICE_HOST_SOURCE, /AssignProcessToJobObject/u);
  assert.match(WINDOWS_SEED_SERVICE_HOST_SOURCE, /0x2000/u);
  assert.match(WINDOWS_SEED_SERVICE_HOST_SOURCE, /case "DevBridgeAccessSeed"/u);
  assert.match(WINDOWS_SEED_SERVICE_HOST_SOURCE, /case "DevBridgeNetworkSeed"/u);
  assert.doesNotMatch(WINDOWS_SEED_SERVICE_HOST_SOURCE, /args\[1\]|UseShellExecute = true/u);
});

test('guest service host compiles on Windows and rejects unknown identities without SCM effects', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-seed-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'seed-service.exe');
  const script = String.raw`$ErrorActionPreference='Stop'
$data=[Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition ([string]$data.source) -Language CSharp -ReferencedAssemblies System.dll,System.ServiceProcess.dll -OutputAssembly ([string]$data.output) -OutputType ConsoleApplication -ErrorAction Stop
`;
  const compiled = await invokeCommand({ executable: 'powershell.exe', arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], input: JSON.stringify({ source: WINDOWS_SEED_SERVICE_HOST_SOURCE, output: executable }), timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  assert.equal(compiled.exitCode, 0, compiled.stderr);
  for (const args of [[], ['unknown'], ['DevBridgeAccessSeed', 'foreign-script.mjs']]) {
    const rejected = await invokeCommand({ executable, arguments: args, timeoutMs: 10_000, maxOutputBytes: 16 * 1024 });
    assert.equal(rejected.exitCode, 2, rejected.stderr);
  }
});
