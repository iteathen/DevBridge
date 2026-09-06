import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const storeUrl = new URL('../src/runtime/accelerator-broker-file-ledger.js', import.meta.url);

test('file ledger store stays provider, transport, and CUDA-backend agnostic', async () => {
  const source = (await readFile(storeUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    'wsl', 'nvidia', 'hyper-v', 'libvirt', 'vfio', 'vsock', 'socket', 'powershell', 'ssh', 'pci', 'pnp',
    'nvcuda', 'libcuda', 'cudamalloc', 'culaunch',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('file ledger store has no process/network/provider authority and does not depend on experimental sqlite', async () => {
  const source = (await readFile(storeUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    "'node:child_process'", '"node:child_process"', "'child_process'", '"child_process"',
    "'node:net'", '"node:net"', 'process.argv', 'shell:', "'node:sqlite'", '"node:sqlite"',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('file ledger publishes prepared immutable revisions without rename replacement', async () => {
  const source = await readFile(storeUrl, 'utf8');
  assert.equal(source.includes("open(tempPath, 'wx', 0o600)"), true);
  assert.equal(source.includes('await handle.sync()'), true);
  assert.equal(source.includes('await link(tempPath, finalPath)'), true);
  assert.equal(source.includes('rename('), false);
});

test('guest key values are hashed before entering storage path construction', async () => {
  const source = await readFile(storeUrl, 'utf8');
  assert.equal(source.includes("update('devbridge/accelerator-broker-file-ledger-key-v1\\0')"), true);
  assert.equal(source.includes('path.join(this.#rootPath, digest.slice(0, 2))'), true);
  assert.equal(source.includes('path.join(fanoutPath, digest)'), true);
  for (const forbidden of [
    'path.join(this.#rootPath, key.sessionIdentity',
    'path.join(this.#rootPath, key.sessionGeneration',
    'path.join(this.#rootPath, key.requestId',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
