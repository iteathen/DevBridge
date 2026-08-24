import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsProductionImageCanaryPreflight } from '../src/runtime/providers/windows-production-image-canary-preflight.js';

function success(value = { ready: true, elevated: true }) {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(value), stderr: '' };
}

const VERIFIER = 'C:\\Program Files\\GnuPG\\bin\\gpgv.exe';

test('physical canary preflight proves host capabilities without invoking a mutating command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-preflight-'));
  const keyring = path.join(root, 'archive.gpg');
  await writeFile(keyring, 'keyring');
  const calls = [];
  try {
    const preflight = new WindowsProductionImageCanaryPreflight({
      platform: 'win32',
      async invoke(request) { calls.push(request); return success(); },
    });
    const result = await preflight.inspect({
      stateDirectory: path.join(root, 'future-state'),
      keyring,
      memoryBytes: 1,
      diskBytes: 1,
      sourceBytes: 1,
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.capabilities, { provider: true, keyring: true, memory: true, storage: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'powershell.exe');
    assert.equal(calls[0].input, null);
    const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
    assert.match(script, /Get-Command/u);
    assert.match(script, /gpgv\.exe/u);
    assert.match(script, /Get-VMHost/u);
    assert.match(script, /Get-NetIPInterface/u);
    assert.match(script, /WindowsPrincipal/u);
    assert.match(script, /MsftFileSystemImage/u);
    const elevationBranch = script.indexOf('if (-not $elevated)');
    const moduleImport = script.indexOf('Import-Module Hyper-V');
    assert.notEqual(elevationBranch, -1);
    assert.ok(elevationBranch < moduleImport);
    assert.doesNotMatch(script, /\b(?:Start-VM|Stop-VM|Remove-VM|New-VHD|New-VMSwitch|New-NetNat|New-NetIPAddress)\s+-/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary preflight rejects a non-elevated token before provider mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-preflight-elevation-'));
  const keyring = path.join(root, 'archive.gpg');
  await writeFile(keyring, 'keyring');
  const calls = [];
  try {
    const preflight = new WindowsProductionImageCanaryPreflight({
      platform: 'win32',
      async invoke(request) { calls.push(request); return success({ ready: true, elevated: false }); },
    });
    const result = await preflight.inspect({ stateDirectory: root, keyring, memoryBytes: 1, diskBytes: 1, sourceBytes: 1 });
    assert.equal(result.ready, false);
    assert.equal(result.capabilities.provider, false);
    assert.match(result.reason, /elevated PowerShell/u);
    assert.equal(calls.length, 1);
    const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
    assert.doesNotMatch(script, /\b(?:New-VMSwitch|New-NetIPAddress|New-NetNat)\s+-/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary preflight rejects capability output without typed elevation evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-preflight-elevation-evidence-'));
  const keyring = path.join(root, 'archive.gpg');
  await writeFile(keyring, 'keyring');
  try {
    const preflight = new WindowsProductionImageCanaryPreflight({
      platform: 'win32',
      invoke: async () => success({ ready: true }),
    });
    const result = await preflight.inspect({ stateDirectory: root, keyring, memoryBytes: 1, diskBytes: 1, sourceBytes: 1 });
    assert.equal(result.ready, false);
    assert.equal(result.capabilities.provider, false);
    assert.match(result.reason, /did not report elevation state/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary preflight consumes an exact verifier binding without rediscovering it through PATH', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-preflight-verifier-'));
  const keyring = path.join(root, 'archive.gpg');
  await writeFile(keyring, 'keyring');
  const calls = [];
  try {
    const preflight = new WindowsProductionImageCanaryPreflight({
      platform: 'win32',
      signatureVerifierExecutable: VERIFIER,
      async invoke(request) { calls.push(request); return success(); },
    });
    const result = await preflight.inspect({
      stateDirectory: path.join(root, 'future-state'),
      keyring,
      memoryBytes: 1,
      diskBytes: 1,
      sourceBytes: 1,
    });
    assert.equal(result.ready, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].executable, 'powershell.exe');
    const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
    assert.doesNotMatch(script, /gpgv\.exe/u);
    assert.equal(calls[1].executable, VERIFIER);
    assert.deepEqual(calls[1].arguments, ['--version']);
    assert.equal(calls[1].input, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary preflight fails closed when the exact verifier binding is not usable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-preflight-verifier-failure-'));
  const keyring = path.join(root, 'archive.gpg');
  await writeFile(keyring, 'keyring');
  try {
    const preflight = new WindowsProductionImageCanaryPreflight({
      platform: 'win32',
      signatureVerifierExecutable: VERIFIER,
      async invoke(request) {
        if (request.executable === 'powershell.exe') return success();
        return { ...success(), exitCode: 1, stderr: 'unusable verifier' };
      },
    });
    const result = await preflight.inspect({ stateDirectory: root, keyring, memoryBytes: 1, diskBytes: 1, sourceBytes: 1 });
    assert.equal(result.ready, false);
    assert.match(result.reason, /signature verifier is not usable/u);
    assert.equal(result.capabilities.provider, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary preflight reports unsupported hosts without probing provider commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-preflight-platform-'));
  const keyring = path.join(root, 'archive.gpg');
  await writeFile(keyring, 'keyring');
  let calls = 0;
  try {
    const preflight = new WindowsProductionImageCanaryPreflight({
      platform: 'linux',
      async invoke() { calls += 1; return success(); },
    });
    const result = await preflight.inspect({ stateDirectory: root, keyring, memoryBytes: 1, diskBytes: 1, sourceBytes: 1 });
    assert.equal(result.ready, false);
    assert.match(result.reason, /Windows Hyper-V host/u);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary preflight reports a missing signature keyring as a blocker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-preflight-keyring-'));
  try {
    const preflight = new WindowsProductionImageCanaryPreflight({ platform: 'win32', invoke: async () => success() });
    const result = await preflight.inspect({ stateDirectory: root, keyring: path.join(root, 'missing.gpg'), memoryBytes: 1, diskBytes: 1, sourceBytes: 1 });
    assert.equal(result.ready, false);
    assert.equal(result.capabilities.keyring, false);
    assert.match(result.reason, /keyring is unavailable/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
