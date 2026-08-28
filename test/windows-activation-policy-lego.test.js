import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = new URL('../src/setup/windows-activation-policy.js', import.meta.url);

test('activation policy value remains isolated from topology, execution, and secret storage', async () => {
  const text = await readFile(source, 'utf8');
  for (const forbidden of [
    'Hyper-V', 'libvirt', 'QEMU', 'guest', 'repository', 'controller', 'productKey', 'credential',
    'slmgr', 'DPAPI', 'child_process', 'command-invocation', 'setup-authority', 'state-store',
  ]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} leaked into the policy value module`);
  }
});
