import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const serviceUrl = new URL('../src/runtime/accelerator-broker-service.js', import.meta.url);

test('accelerator broker service framing stays provider and endpoint agnostic', async () => {
  const source = (await readFile(serviceUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    'wsl', 'nvidia', 'hyper-v', 'libvirt', 'vfio', 'vsock', 'socket', 'powershell', 'ssh', 'pci', 'pnp',
    'endpoint', 'guestcommunicationservices', 'addressfamily', 'af_hyperv', 'af_vsock',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('accelerator broker service framing owns no process filesystem network or lifecycle authority', async () => {
  const source = (await readFile(serviceUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    "from 'node:net'", "from 'node:child_process'", "from 'node:fs'", 'process.argv', 'spawn(', 'exec(',
    'shell:', 'executable', 'workingdirectory', 'working-directory', 'filepath', 'file-path', '.retire(',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('accelerator broker service exposes only the sealed broker request bodies', async () => {
  const source = await readFile(serviceUrl, 'utf8');
  assert.equal(source.includes('normalizeAcceleratorBrokerExecuteRequest'), true);
  assert.equal(source.includes('normalizeAcceleratorBrokerCancelRequest'), true);
  assert.equal(source.includes('normalizeAcceleratorBrokerObservation'), true);
  assert.equal(source.includes("EXECUTE: 'execute'"), true);
  assert.equal(source.includes("OBSERVE: 'observe'"), true);
  assert.equal(source.includes("CANCEL: 'cancel'"), true);
});
