import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsProtectedImageConstructionPreflight } from '../src/runtime/providers/windows-protected-image-construction-preflight.js';

function success() {
  return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"ready":true}', stderr: '' };
}

test('protected image construction preflight proves exact read-only provider prerequisites', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-protected-preflight-'));
  const calls = [];
  try {
    const preflight = new WindowsProtectedImageConstructionPreflight({
      platform: 'win32',
      invoke: async (request) => { calls.push(request); return success(); },
    });
    const result = await preflight.inspect({ stateDirectory: root, memoryBytes: 1, diskBytes: 2, allocationBytes: 1, sourceBytes: 1 });
    assert.equal(result.ready, true);
    assert.deepEqual(result.capabilities, { provider: true, connectivity: true, memory: true, storage: true });
    const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
    assert.match(script, /Set-VMKeyProtector/u);
    assert.match(script, /Enable-VMTPM/u);
    assert.match(script, /Get-VMIntegrationService/u);
    assert.match(script, /Enable-VMIntegrationService/u);
    assert.match(script, /MsftFileSystemImage/u);
    assert.doesNotMatch(script, /\b(?:New-VM|Start-VM|Set-VMKeyProtector|Enable-VMTPM)\s+-/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('protected image construction preflight fails closed without provider or connectivity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-protected-preflight-denial-'));
  try {
    const unsupported = new WindowsProtectedImageConstructionPreflight({ platform: 'linux', invoke: async () => { throw new Error('must not execute'); } });
    const result = await unsupported.inspect({ stateDirectory: root, memoryBytes: 1, diskBytes: 2, allocationBytes: 1, sourceBytes: 1 });
    assert.equal(result.ready, false);
    assert.match(result.reason, /Windows virtualization host/u);

    const disconnected = new WindowsProtectedImageConstructionPreflight({
      platform: 'win32',
      invoke: async () => success(),
      network: { async inspect() { return { ready: false, reason: 'bounded connectivity unavailable' }; } },
    });
    const unavailable = await disconnected.inspect({ stateDirectory: root, memoryBytes: 1, diskBytes: 2, allocationBytes: 1, sourceBytes: 1 });
    assert.equal(unavailable.ready, false);
    assert.match(unavailable.reason, /bounded connectivity unavailable/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('protected image construction preflight has no guest, repository, or source authority', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/runtime/providers/windows-protected-image-construction-preflight.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /GitHub|repository[A-Z]|edition|product.?key|Codex|CUDA/iu);
});

test('construction and final images retain separate reserves only on distinct observed volumes', async () => {
  const GiB = 1024 ** 3;
  const stateDirectory = path.resolve('control');
  const storageDirectory = path.resolve('bulk');
  const request = { stateDirectory, storageDirectory, memoryBytes: 1, diskBytes: 8 * GiB, allocationBytes: 6 * GiB, sourceBytes: 6 * GiB };
  const observed = [];
  let finalVolume = 'final';
  let finalAvailable = 8 * GiB;
  const preflight = new WindowsProtectedImageConstructionPreflight({
    platform: 'win32', invoke: async () => success(),
    network: { async inspect() { return { ready: true, description: { binding: { control: 'system' }, addressing: { method: 'automatic' } } }; } },
    storageProbe: async (location) => {
      observed.push(location);
      return location === storageDirectory ? { volume: 'build', availableBytes: 20 * GiB } : { volume: finalVolume, availableBytes: finalAvailable };
    },
  });
  const split = await preflight.inspect(request);
  assert.equal(split.ready, true);
  assert.deepEqual(observed, [storageDirectory, stateDirectory]);
  assert.equal(split.resources.storage.requiredBytes, 15 * GiB);
  assert.equal(split.resources.imageStorage.requiredBytes, 8 * GiB);
  finalAvailable = 7 * GiB;
  const fullImageDrive = await preflight.inspect(request);
  assert.equal(fullImageDrive.ready, false);
  assert.equal(fullImageDrive.capabilities.storage, false);
  finalVolume = 'build';
  finalAvailable = 20 * GiB;
  const sameVolume = await preflight.inspect(request);
  assert.equal(sameVolume.ready, false);
  assert.match(sameVolume.reason, /writable storage/u);
  assert.equal(sameVolume.capabilities.storage, false);
});

test('invalid storage observations cannot declare readiness', async () => {
  for (const observation of [{ volume: '', availableBytes: 1 }, { volume: 'one', availableBytes: -1 }, { volume: 'one', availableBytes: Infinity }, null]) {
    const preflight = new WindowsProtectedImageConstructionPreflight({
      platform: 'win32', invoke: async () => success(), storageProbe: async () => observation,
      network: { async inspect() { return { ready: false }; } },
    });
    const result = await preflight.inspect({ stateDirectory: os.tmpdir(), memoryBytes: 1, diskBytes: 2, allocationBytes: 1, sourceBytes: 1 });
    assert.equal(result.ready, false);
    assert.equal(result.capabilities.storage, false);
    assert.match(result.reason, /storage observation is invalid/u);
  }
});

test('preparation budgets both source and bootable copy before construction removes the source', async () => {
  const GiB = 1024 ** 3;
  const preflight = new WindowsProtectedImageConstructionPreflight({
    platform: 'win32', invoke: async () => success(),
    storageProbe: async () => ({ volume: 'one', availableBytes: 40 * GiB }),
    network: { async inspect() { return { ready: true, description: { binding: { control: 'system' }, addressing: { method: 'automatic' } } }; } },
  });
  const request = { stateDirectory: os.tmpdir(), memoryBytes: 1, diskBytes: 8 * GiB, allocationBytes: 4 * GiB, sourceBytes: 10 * GiB, preparedSourceBytes: 11 * GiB };
  const prepared = await preflight.inspect(request);
  assert.equal(prepared.ready, true);
  assert.equal(prepared.resources.storage.sourceBytes, 21 * GiB);
  const construction = await preflight.inspect({ ...request, allocationBytes: 8 * GiB });
  assert.equal(construction.resources.storage.sourceBytes, 27 * GiB);
  const overflow = await preflight.inspect({ ...request, preparedSourceBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(overflow.ready, false);
  assert.equal(overflow.capabilities.storage, false);
});
