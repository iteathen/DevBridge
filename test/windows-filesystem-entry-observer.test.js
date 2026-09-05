import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsFilesystemEntryObserver } from '../src/runtime/providers/windows-filesystem-entry-observer.js';

const protocol = 'devbridge/windows-filesystem-entry-observation-v1';

function result(entries) {
  return { exitCode: 0, stdout: JSON.stringify({ protocol, results: entries }), stderr: '', timedOut: false, aborted: false, outputTruncated: false };
}

test('Windows filesystem observer invokes one fixed bounded attribute batch probe', async () => {
  let request = null;
  const observer = createWindowsFilesystemEntryObserver({
    async invoke(value) {
      request = value;
      return result([{ index: 0, exists: true, reparse: false }]);
    },
  });
  assert.equal(await observer.isReparse('C:\\owned\\artifact.bin'), false);
  assert.equal(request.executable, 'powershell.exe');
  assert.equal(request.arguments.includes('-EncodedCommand'), true);
  assert.equal(request.input, JSON.stringify({ locations: ['C:\\owned\\artifact.bin'] }));
  assert.equal(request.arguments.some((entry) => entry.includes('owned')), false);
});

test('Windows filesystem observer binds batch result count and order', async () => {
  const requests = [];
  const observer = createWindowsFilesystemEntryObserver({
    async invoke(value) {
      requests.push(value);
      return result([
        { index: 0, exists: true, reparse: false },
        { index: 1, exists: false, reparse: false },
      ]);
    },
  });
  assert.deepEqual(await observer.inspectReparseBatch(['C:\\owned\\first', 'C:\\owned\\missing']), [
    { exists: true, reparse: false },
    { exists: false, reparse: false },
  ]);
  assert.equal(requests.length, 1);

  const reordered = createWindowsFilesystemEntryObserver({
    invoke: async () => result([{ index: 1, exists: true, reparse: false }]),
  });
  await assert.rejects(() => reordered.inspectReparseBatch(['C:\\owned\\first']), /invalid/u);
});

test('Windows filesystem observer rejects malformed output and bounded input', async () => {
  const observer = createWindowsFilesystemEntryObserver({ invoke: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) });
  await assert.rejects(() => observer.isReparse('C:\\owned\\artifact.bin'), /invalid/u);
  await assert.rejects(() => observer.isReparse('bad\0path'), /location/u);
  await assert.rejects(() => observer.inspectReparseBatch([]), /locations/u);
  await assert.rejects(() => observer.inspectReparseBatch(Array.from({ length: 513 }, (_, index) => `C:\\owned\\${index}`)), /locations/u);
});
