import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const stateUrl = new URL('../src/runtime/accelerator-broker-generation-state.js', import.meta.url);
const admissionUrl = new URL('../src/runtime/accelerator-broker-generation-admission.js', import.meta.url);
const controllerUrl = new URL('../src/runtime/accelerator-broker-generation-controller.js', import.meta.url);
const fileStateUrl = new URL('../src/runtime/accelerator-broker-file-generation-state.js', import.meta.url);
const coreUrl = new URL('../src/runtime/accelerator-broker-core.js', import.meta.url);

function assertAbsent(source, forbidden) {
  for (const value of forbidden) assert.equal(source.includes(value), false, value);
}

test('neutral generation state has no persistence, transport, provider, process, or CUDA authority', async () => {
  const source = (await readFile(stateUrl, 'utf8')).toLowerCase();
  assertAbsent(source, [
    'node:fs', 'node:path', 'node:net', 'child_process', 'hyper-v', 'libvirt', 'wsl', 'vsock',
    'socket', 'powershell', 'ssh', 'nvidia', 'nvcuda', 'libcuda', 'cudamalloc', 'culaunch',
  ]);
});

test('generation admission is an in-memory synchronization LEGO only', async () => {
  const source = (await readFile(admissionUrl, 'utf8')).toLowerCase();
  assertAbsent(source, [
    'node:fs', 'node:path', 'node:net', 'child_process', 'process.', 'hyper-v', 'libvirt', 'wsl', 'vsock',
    'socket', 'powershell', 'ssh', 'nvidia', 'cuda', 'ledger', 'catalog', 'backend', 'provider',
  ]);
});

test('generation controller composes neutral ports without host persistence, process, provider, transport, or CUDA mechanics', async () => {
  const source = (await readFile(controllerUrl, 'utf8')).toLowerCase();
  assertAbsent(source, [
    'node:fs', 'node:path', 'node:net', 'child_process', 'process.', 'hyper-v', 'libvirt', 'wsl', 'vsock',
    'socket', 'powershell', 'ssh', 'nvidia', 'nvcuda', 'libcuda', 'cudamalloc', 'culaunch',
    'rootpath', 'filepath', 'hostname', 'portnumber',
  ]);
});

test('file generation state adapter owns persistence mechanics only', async () => {
  const source = (await readFile(fileStateUrl, 'utf8')).toLowerCase();
  assertAbsent(source, [
    "'node:child_process'", '"node:child_process"', "'node:net'", '"node:net"',
    'process.argv', 'shell:', 'hyper-v', 'libvirt', 'wsl', 'vsock', 'socket', 'powershell', 'ssh',
    'nvidia', 'nvcuda', 'libcuda', 'cudamalloc', 'culaunch', 'ensureexecution', 'ensurecancellation',
  ]);
});

test('accelerator broker core remains free of generation retirement/promotion composition authority', async () => {
  const source = (await readFile(coreUrl, 'utf8')).toLowerCase();
  assert.equal(source.includes('accelerator-broker-generation-controller'), false);
  assert.equal(source.includes('accelerator-broker-generation-state'), false);
  assert.equal(source.includes('retiregeneration'), false);
  assert.equal(source.includes('promotegeneration'), false);
  assert.equal(source.includes('observegeneration'), false);
});
