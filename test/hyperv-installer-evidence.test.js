import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHyperVInstallerEvidence } from '../src/runtime/providers/hyperv-installer-evidence.js';
import { INSTALLER_EVIDENCE_PROTOCOL } from '../src/runtime/construction-install-evidence.js';
import { invokeCommand } from '../src/runtime/command-invocation.js';

const identity = 'a'.repeat(32);
const binding = { subject: 'subject-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', providerInstance: '11111111-2222-3333-4444-555555555555', seedSha256: 'c'.repeat(64), attempt: 1 };
const attachment = { providerIdentity: binding.providerInstance, name: 'db-image-build-0123456789abcdef', marker: `devbridge-owned:${identity}:image-build:${binding.subject}:v1`, seed: { location: 'C:\\owned\\seed.iso', bytes: 2048, sha256: binding.seedSha256 } };
function response(overrides = {}) {
  return Buffer.from(JSON.stringify({
    protocol: INSTALLER_EVIDENCE_PROTOCOL, identity: binding.subject, attempt: 1, sequence: 2,
    phase: 'failed', stage: 'apt-install', exitCode: 100, collection: 'unavailable',
    truncated: false, stdoutBase64: '', stderrBase64: '', ...overrides,
  }));
}
function result(bytes) {
  return { exitCode: 0, stdout: JSON.stringify({ available: true, bytesBase64: bytes.toString('base64') }), stderr: '', timedOut: false, aborted: false, outputTruncated: false };
}

test('native installer reads bind one installation and VM and reject wildcard or foreign attachments before invocation', async () => {
  const requests = [];
  const reader = createHyperVInstallerEvidence({ identity, invoke: async request => { requests.push(request); return result(response()); } });
  const observed = await reader.read({ binding, attachment });
  assert.equal(observed.status, 'available');
  const payload = JSON.parse(requests[0].input);
  assert.equal(payload.vmId, binding.providerInstance);
  assert.equal(payload.serviceId, reader.serviceId);
  assert.equal(payload.diagnostics, false);
  assert.equal(reader.guestPort, Number.parseInt(reader.serviceId.slice(0, 8), 16));
  assert.ok(reader.guestPort > 1024 && reader.guestPort < 0xffffffff);
  assert.notEqual(reader.serviceId, createHyperVInstallerEvidence({ identity: 'd'.repeat(32), invoke: async () => {} }).serviceId);
  for (const vm of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '90db8b89-0d35-4f79-8ce9-49ea0ac8b7cd', 'e0e16197-dd56-4a10-9195-5ee7a155a838', 'a42e7cda-d03f-480c-9cc2-a4de20abb878']) {
    await assert.rejects(() => reader.read({ binding: { ...binding, providerInstance: vm }, attachment: { ...attachment, providerIdentity: vm } }), /attachment/u);
  }
  await assert.rejects(() => reader.read({ binding, attachment: { ...attachment, marker: 'another-owner' } }), /attachment/u);
  await assert.rejects(() => reader.read({ binding, attachment: { ...attachment, seed: { ...attachment.seed, sha256: 'd'.repeat(64) } } }), /attachment/u);
  await assert.rejects(() => reader.readDiagnostics({ binding, attachment, sequence: 0 }), /attachment/u);
  assert.equal(requests.length, 1);
});

test('native collector absence, incomplete frames and wrong diagnostic sequences cannot fabricate useful evidence', async () => {
  let selected = { exitCode: 1, stdout: '', stderr: 'socket connection failed' };
  const reader = createHyperVInstallerEvidence({ identity, invoke: async () => selected });
  assert.equal((await reader.read({ binding, attachment })).status, 'unavailable');
  for (selected of [result(response({ identity: 'another-subject' })), result(Buffer.alloc(4097)), { ...result(response()), stdout: 'invalid' }]) {
    await assert.rejects(() => reader.read({ binding, attachment }));
  }
  selected = result(response({ sequence: 3 }));
  await assert.rejects(() => reader.readDiagnostics({ binding, attachment, sequence: 2 }), /sequence/u);
  selected = { ...result(response()), outputTruncated: true };
  assert.equal((await reader.read({ binding, attachment })).status, 'unavailable');
});

test('installer evidence connects as a host client without registry registration or a host listener', async () => {
  let request;
  const reader = createHyperVInstallerEvidence({ identity, invoke: async value => { request = value; return result(response()); } });
  await reader.read({ binding, attachment });
  const script = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
  assert.doesNotMatch(script, /GuestCommunicationServices|HKLM:|Get-ItemProperty|New-Item|RunAs|socket\.(?:Bind|Listen|Accept)\(/u);
  assert.match(script, /Get-VM -Id/u);
  assert.match(script, /Get-VMDvdDrive/u);
  assert.match(script, /ComputeHash\(\$seedStream\)/u);
  assert.match(script, /socket\.Connect\(new DevBridgeInstallerEndpoint\(machine, service\)\)/u);
  assert.ok(script.indexOf('ComputeHash') < script.indexOf('[DevBridgeInstallerSocket]::Read'));
});

test('Windows native endpoint compiles and serializes exact Hyper-V GUIDs without contacting a VM', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-installer-endpoint-'));
  try {
    let request;
    const reader = createHyperVInstallerEvidence({ identity, invoke: async value => { request = value; return result(response()); } });
    await reader.read({ binding, attachment });
    const script = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
    const match = script.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]+?)\r?\n'@/u);
    assert.ok(match);
    const source = path.join(root, 'endpoint.cs');
    await writeFile(source, match[1]);
    const native = path.join(root, 'check.ps1');
    await writeFile(native, `$ErrorActionPreference = 'Stop'\nAdd-Type -LiteralPath (Join-Path $PSScriptRoot 'endpoint.cs')\n$endpoint = New-Object DevBridgeInstallerEndpoint([guid]'${binding.providerInstance}', [guid]'${reader.serviceId}')\n$address = $endpoint.Serialize()\n$bytes = for ($i = 0; $i -lt $address.Size; $i++) { [int]$address[$i] }\nConvertTo-Json -InputObject @($bytes) -Compress\n`);
    const verified = await invokeCommand({ executable: 'powershell.exe', arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', native], timeoutMs: 30_000, maxOutputBytes: 16 * 1024 });
    assert.equal(verified.exitCode, 0, verified.stderr);
    const bytes = JSON.parse(verified.stdout);
    assert.equal(bytes.length, 36);
    assert.deepEqual(bytes.slice(0, 4), [34, 0, 0, 0]);
    assert.deepEqual(bytes.slice(4, 20), [17, 17, 17, 17, 34, 34, 51, 51, 68, 68, 85, 85, 85, 85, 85, 85]);
    const port = Buffer.from(bytes.slice(20, 24)).readUInt32LE();
    assert.equal(port, reader.guestPort);
    assert.deepEqual(bytes.slice(24), [203, 250, 230, 17, 189, 88, 100, 0, 106, 121, 134, 211]);
    assert.equal((await readFile(source, 'utf8')).includes('DevBridgeInstallerSocket'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows seed verification hashes the actual file without an optional PowerShell hash command', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-installer-seed-hash-'));
  try {
    let request;
    const reader = createHyperVInstallerEvidence({ identity, invoke: async value => { request = value; return result(response()); } });
    await reader.read({ binding, attachment });
    const script = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
    const seedCheck = script.slice(script.indexOf('$seed = Get-Item'), script.indexOf('Add-Type'));
    const seedPath = path.join(root, 'seed.iso');
    const seedBytes = Buffer.from('owned seed bytes');
    await writeFile(seedPath, seedBytes);
    const seedSha256 = createHash('sha256').update(seedBytes).digest('hex');
    const native = path.join(root, 'check.ps1');
    await writeFile(native, `$ErrorActionPreference = 'Stop'\n$data = [Console]::In.ReadToEnd() | ConvertFrom-Json\nfunction Get-FileHash { throw 'Get-FileHash is unavailable' }\n${seedCheck}\n'checked'\n`);
    for (const digest of [seedSha256, '0'.repeat(64)]) {
      const checked = await invokeCommand({ executable: 'powershell.exe', arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', native],
        input: JSON.stringify({ seedPath, seedBytes: seedBytes.length, seedSha256: digest }), timeoutMs: 30_000, maxOutputBytes: 16 * 1024 });
      assert.equal(checked.exitCode, digest === seedSha256 ? 0 : 1, checked.stderr);
      if (digest === seedSha256) assert.equal(checked.stdout.trim(), 'checked');
      else assert.match(checked.stderr, /seed bytes changed/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
