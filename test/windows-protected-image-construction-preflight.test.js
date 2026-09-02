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
