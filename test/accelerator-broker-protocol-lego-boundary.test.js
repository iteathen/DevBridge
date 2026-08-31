import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const protocolUrl = new URL('../src/runtime/accelerator-broker-protocol.js', import.meta.url);

test('accelerator broker protocol stays transport and provider agnostic', async () => {
  const source = (await readFile(protocolUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    'wsl', 'nvidia', 'hyper-v', 'libvirt', 'vfio', 'vsock', 'socket', 'powershell', 'ssh', 'pci', 'pnp',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('accelerator broker protocol has no general host execution or filesystem surface', async () => {
  const source = (await readFile(protocolUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    "from 'node:child_process'", "from 'node:fs'", "from 'node:net'", 'process.argv', 'spawn(', 'exec(',
    'shell:', 'executable', 'argv', 'workingdirectory', 'working-directory', 'filepath', 'file-path',
    'kerneltext', 'kernel-text', 'modulebytes', 'module-bytes',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('first protocol slice exposes exactly one sealed canary operation rather than arbitrary CUDA launch', async () => {
  const source = await readFile(protocolUrl, 'utf8');
  assert.equal(source.includes("CUDA_CANARY_U32_ADD_V1: 'cuda.canary.u32-add-v1'"), true);
  assert.equal(source.includes('MAX_CANARY_VECTOR_LENGTH'), true);
  assert.equal(source.includes('REQUEST_CONFLICT'), true);
  assert.equal(source.includes('STATE_UNKNOWN'), true);
});
