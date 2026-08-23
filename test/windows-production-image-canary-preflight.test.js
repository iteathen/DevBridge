import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsProductionImageCanaryPreflight } from '../src/runtime/providers/windows-production-image-canary-preflight.js';

function success(value = { ready: true }) {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(value), stderr: '' };
}

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
    assert.match(script, /Get-VMHost/u);
    assert.match(script, /MsftFileSystemImage/u);
    assert.doesNotMatch(script, /\b(?:Start-VM|Stop-VM|Remove-VM|New-VHD|New-VMSwitch|New-NetNat|New-NetIPAddress)\s+-/u);
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
