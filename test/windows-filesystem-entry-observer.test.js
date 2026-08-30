import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsFilesystemEntryObserver } from '../src/runtime/providers/windows-filesystem-entry-observer.js';

test('Windows filesystem observer invokes one fixed path-literal attribute probe', async () => {
  let request = null;
  const observer = createWindowsFilesystemEntryObserver({
    async invoke(value) {
      request = value;
      return { exitCode: 0, stdout: JSON.stringify({ exists: true, reparse: false }), stderr: '', timedOut: false, aborted: false, outputTruncated: false };
    },
  });
  assert.equal(await observer.isReparse('C:\\owned\\artifact.bin'), false);
  assert.equal(request.executable, 'powershell.exe');
  assert.equal(request.arguments.includes('-EncodedCommand'), true);
  assert.equal(request.input, JSON.stringify({ location: 'C:\\owned\\artifact.bin' }));
  assert.equal(request.arguments.some((entry) => entry.includes('owned')), false);
});

test('Windows filesystem observer rejects malformed output and bounded input', async () => {
  const observer = createWindowsFilesystemEntryObserver({ invoke: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) });
  await assert.rejects(() => observer.isReparse('C:\\owned\\artifact.bin'), /invalid/u);
  await assert.rejects(() => observer.isReparse('bad\0path'), /location/u);
});
