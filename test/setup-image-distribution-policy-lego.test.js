import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = new URL('../src/app/setup-image-distribution-policy.js', import.meta.url);

test('distribution-policy reconciliation is profile-neutral and contains no external topology', async () => {
  const text = await readFile(source, 'utf8');
  for (const forbidden of [
    'windows-development', 'linux-development', 'GitHub', 'Hyper-V', 'libvirt', 'QEMU',
    'guest', 'repository', 'releaseId', 'manifestAsset', 'manifestDigest', 'credential',
    'fetch', 'child_process', 'command-invocation',
  ]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} leaked into the profile-neutral reconciler`);
  }
});
