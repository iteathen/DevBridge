import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HyperVPersistentEnvironment } from '../src/runtime/providers/hyperv-persistent-environment.js';

function success(value) {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(value), stderr: '' };
}

function decode(request) {
  return Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
}

test('Hyper-V persistent adapter owns differencing-disk creation and exact lineage checks locally', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-hv-'));
  const sourceRoot = path.join(root, 'images');
  const sourcePath = path.join(sourceRoot, 'base.vhdx');
  const calls = [];
  let state = 'off';
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(sourcePath, 'immutable-base');
    const invoke = async (request) => {
      calls.push(request);
      const script = decode(request);
      const input = JSON.parse(request.input);
      if (script.includes('New-VHD') && script.includes('New-VM')) {
        await mkdir(path.dirname(input.diskPath), { recursive: true });
        await writeFile(input.diskPath, 'child-state');
        return success({ ready: true, providerIdentity: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
      }
      if (script.includes('Get-VMHardDiskDrive')) {
        return success({ exists: true, owned: true, compatible: true, state, storageIdentity: 'disk-child-1', allocatedBytes: 8192 });
      }
      if (script.includes('Start-VM')) { state = 'running'; return success({ changed: true }); }
      if (script.includes('Stop-VM')) { state = 'off'; return success({ changed: true }); }
      if (script.includes('Remove-VM')) { return success({ removed: true, absent: false }); }
      throw new Error('unexpected PowerShell request');
    };
    const adapter = new HyperVPersistentEnvironment({
      directory: path.join(root, 'persistent'), sourceRoot,
      identity: '0123456789abcdef0123456789abcdef', invoke,
    });
    const identity = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const source = { identity: 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', revision: 'r1', digest: 'a'.repeat(64), handle: { location: sourcePath, format: 'vhdx' } };
    const settings = { memoryBytes: 2147483648, processorCount: 2, firmware: 'efi' };
    const created = await adapter.provision({ identity, source, settings });
    assert.equal(created.compatible, true);
    assert.equal(created.storage.sourceIdentity, source.identity);
    assert.equal(calls.every((call) => call.executable === 'powershell.exe'), true);
    const provisionScript = decode(calls[0]);
    assert.match(provisionScript, /New-VHD -Path \$data\.diskPath -ParentPath \$data\.parentPath -Differencing/u);
    assert.match(provisionScript, /AutomaticCheckpointsEnabled \$false/u);
    assert.match(provisionScript, /IsNullOrWhiteSpace\(\[string\]\$item\.Notes\)/u);
    assert.match(provisionScript, /\$attachedMatches/u);
    assert.match(provisionScript, /providerIdentity/u);
    assert.equal(provisionScript.includes('owner/project'), false);

    assert.equal((await adapter.start(identity)).state, 'running');
    assert.equal((await adapter.stop(identity)).state, 'off');
    assert.equal(await readFile(sourcePath, 'utf8'), 'immutable-base');

    const stateFile = path.join(root, 'persistent', 'state.json');
    const adapterState = JSON.parse(await readFile(stateFile, 'utf8'));
    const diskPath = adapterState.records[identity].diskPath;
    await unlink(diskPath);
    await writeFile(diskPath, 'replacement');
    const tampered = await adapter.observe(identity);
    assert.equal(tampered.compatible, false);
    assert.match(tampered.reason, /writable filesystem identity changed/u);
    await assert.rejects(() => adapter.drop(identity), /writable filesystem identity changed/u);
    assert.equal(calls.some((call) => decode(call).includes('Remove-VM')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Hyper-V persistent adapter rejects source paths outside its admitted root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-hv-path-'));
  const sourceRoot = path.join(root, 'images');
  const outside = path.join(root, 'outside.vhdx');
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(outside, 'outside');
    const adapter = new HyperVPersistentEnvironment({
      directory: path.join(root, 'persistent'), sourceRoot,
      identity: '0123456789abcdef0123456789abcdef', invoke: async () => success({}),
    });
    await assert.rejects(() => adapter.provision({
      identity: 'env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      source: { identity: 'img-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', revision: 'r1', digest: 'b'.repeat(64), handle: { location: outside, format: 'vhdx' } },
      settings: { memoryBytes: 2147483648, processorCount: 2, firmware: 'efi' },
    }), /outside the admitted root/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Hyper-V persistent adapter validates its own settings stud before invoking management', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-hv-contract-'));
  const sourceRoot = path.join(root, 'images');
  const sourcePath = path.join(sourceRoot, 'base.vhdx');
  const calls = [];
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(sourcePath, 'immutable-base');
    const adapter = new HyperVPersistentEnvironment({
      directory: path.join(root, 'persistent'), sourceRoot,
      identity: '0123456789abcdef0123456789abcdef', invoke: async (request) => { calls.push(request); return success({}); },
    });
    await assert.rejects(() => adapter.provision({
      identity: 'env-ffffffffffffffffffffffffffffffff',
      source: { identity: 'img-ffffffffffffffffffffffffffffffff', revision: 'r1', digest: 'f'.repeat(64), handle: { location: sourcePath, format: 'vhdx' } },
      settings: { memoryBytes: 2147483648, processorCount: '2', firmware: 'efi' },
    }), /processorCount is invalid/u);
    assert.equal(calls.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Hyper-V persistent adapter translates neutral protected boot and observes exact provider state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-hv-protected-'));
  const sourceRoot = path.join(root, 'images');
  const sourcePath = path.join(sourceRoot, 'base.vhdx');
  const calls = [];
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(sourcePath, 'immutable-base');
    const invoke = async (request) => {
      calls.push(request);
      const script = decode(request);
      const input = JSON.parse(request.input);
      if (script.includes('New-VHD') && script.includes('New-VM')) {
        await mkdir(path.dirname(input.diskPath), { recursive: true });
        await writeFile(input.diskPath, 'child-state');
        return success({ ready: true, providerIdentity: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
      }
      if (script.includes('Get-VMHardDiskDrive')) return success({ exists: true, owned: true, compatible: true, state: 'off', storageIdentity: 'disk-child-1', allocatedBytes: 8192 });
      throw new Error('unexpected PowerShell request');
    };
    const adapter = new HyperVPersistentEnvironment({
      directory: path.join(root, 'persistent'), sourceRoot,
      identity: '0123456789abcdef0123456789abcdef', invoke,
    });
    await adapter.provision({
      identity: 'env-11111111111111111111111111111111',
      source: { identity: 'img-11111111111111111111111111111111', revision: 'r1', digest: '1'.repeat(64), handle: { location: sourcePath, format: 'vhdx' } },
      settings: {
        memoryBytes: 4294967296,
        processorCount: 2,
        firmware: 'efi',
        bootProtection: { integrity: 'required', identity: 'required', trust: 'platform-owner' },
      },
    });
    const provision = calls.find((call) => decode(call).includes('New-VHD'));
    const script = decode(provision);
    const payload = JSON.parse(provision.input);
    assert.equal(payload.integrityRequired, true);
    assert.equal(payload.identityRequired, true);
    assert.equal(typeof payload.trustTemplate, 'string');
    assert.match(script, /Get-VMFirmware/u);
    assert.match(script, /Get-VMSecurity/u);
    assert.match(script, /Set-VMKeyProtector[^\r\n]+-NewLocalKeyProtector/u);
    assert.match(script, /Enable-VMTPM/u);
    assert.ok(script.indexOf('Enable-VMTPM') < script.indexOf('-Notes $data.marker'), 'protection must precede ownership admission');
    const observation = calls.find((call) => decode(call).includes('environment writable state is missing'));
    assert.match(decode(observation), /environment firmware integrity does not match/u);
    assert.match(decode(observation), /environment protected identity does not match/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
