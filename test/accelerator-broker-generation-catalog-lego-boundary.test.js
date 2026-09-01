import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const logicalUrl = new URL('../src/runtime/accelerator-broker-generation-catalog.js', import.meta.url);
const fileUrl = new URL('../src/runtime/accelerator-broker-file-ledger-catalog.js', import.meta.url);
const coreUrl = new URL('../src/runtime/accelerator-broker-core.js', import.meta.url);

test('logical generation catalog is provider, filesystem, transport, and backend agnostic', async () => {
  const source = (await readFile(logicalUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    'node:fs', 'node:path', 'child_process', 'wsl', 'nvidia', 'hyper-v', 'libvirt', 'vfio', 'vsock',
    'socket', 'powershell', 'ssh', 'pci', 'nvcuda', 'libcuda', 'cudamalloc', 'culaunch',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('file generation catalog has read-only persistence authority only', async () => {
  const source = (await readFile(fileUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    "'node:child_process'", '"node:child_process"', "'node:net'", '"node:net"',
    'process.argv', 'shell:', 'writefile', 'mkdir(', 'unlink(', 'rename(', 'link(',
    'wsl', 'nvidia', 'hyper-v', 'libvirt', 'vfio', 'vsock', 'powershell', 'ssh', 'pci',
    'nvcuda', 'libcuda', 'cudamalloc', 'culaunch',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('accelerator broker core is not widened with generation enumeration or promotion authority', async () => {
  const source = await readFile(coreUrl, 'utf8');
  assert.equal(source.includes('accelerator-broker-generation-catalog'), false);
  assert.equal(source.includes('observeGeneration'), false);
  assert.equal(source.includes('promoteGeneration'), false);
  assert.equal(source.includes('retireGeneration'), false);
});
