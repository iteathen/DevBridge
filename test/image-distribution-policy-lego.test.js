import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = new URL('../src/setup/image-distribution-policy.js', import.meta.url);

test('image distribution policy remains isolated from topology, transport, and storage adapters', async () => {
  const text = await readFile(source, 'utf8');
  for (const forbidden of [
    'GitHub', 'Windows', 'Ubuntu', 'Hyper-V', 'libvirt', 'QEMU', 'guest', 'repository',
    'releaseId', 'manifestAsset', 'manifestDigest', 'credential', 'fetch', 'child_process',
    'command-invocation', 'setup-authority', 'state-store',
  ]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} leaked into the distribution policy value module`);
  }
});
