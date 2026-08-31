import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const coreUrl = new URL('../src/runtime/accelerator-broker-core.js', import.meta.url);
const ledgerUrl = new URL('../src/runtime/accelerator-broker-ledger.js', import.meta.url);

test('broker core and ledger remain provider and transport agnostic', async () => {
  const source = `${await readFile(coreUrl, 'utf8')}\n${await readFile(ledgerUrl, 'utf8')}`.toLowerCase();
  for (const forbidden of [
    'wsl', 'nvidia', 'hyper-v', 'libvirt', 'vfio', 'vsock', 'socket', 'powershell', 'ssh', 'pci', 'pnp',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('broker core has no direct process, filesystem, network, or CUDA-driver authority', async () => {
  const source = `${await readFile(coreUrl, 'utf8')}\n${await readFile(ledgerUrl, 'utf8')}`.toLowerCase();
  for (const forbidden of [
    "node:child_process", "node:fs", "node:net", 'process.argv', 'spawn(', 'exec(', 'shell:',
    'nvcuda', 'libcuda', 'cudamalloc', 'culaunch', 'deviceid', 'devicename', 'filepath', 'executable',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('backend port names encode idempotent recovery semantics rather than a raw start primitive', async () => {
  const source = await readFile(coreUrl, 'utf8');
  assert.equal(source.includes("['ensureExecution', 'observeExecution', 'ensureCancellation']"), true);
  assert.equal(source.includes('.start('), false);
  assert.equal(source.includes('.launch('), false);
});
