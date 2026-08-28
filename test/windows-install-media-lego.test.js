import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Windows media authority remains provider, repository, activation, and host-path agnostic', async () => {
  const source = await readFile(new URL('../src/runtime/image-builders/windows-install-media-authority.js', import.meta.url), 'utf8');
  for (const forbidden of [/HyperV/u, /libvirt/u, /qemu/u, /GitHub/u, /repository[A-Z]/u, /product.?key/iu, /activation/iu, /DPAPI/u, /Codex/u, /CUDA/u, /[A-Z]:\\/u]) {
    assert.equal(forbidden.test(source), false, `Windows media authority leaked ${forbidden}`);
  }
});

test('Windows media inspector owns only source inspection and no VM or neighboring authority', async () => {
  const source = await readFile(new URL('../src/runtime/image-sources/windows-install-media-inspector.js', import.meta.url), 'utf8');
  for (const forbidden of [/HyperV/u, /New-VM/u, /VHDX/iu, /GitHub/u, /repository[A-Z]/u, /product.?key/iu, /activation/iu, /Codex/u, /CUDA/u]) {
    assert.equal(forbidden.test(source), false, `Windows media inspector leaked ${forbidden}`);
  }
});

test('Windows media authority persistence remains a thin state adapter', async () => {
  const source = await readFile(new URL('../src/state/windows-install-media-authority-state-store.js', import.meta.url), 'utf8');
  assert.equal(/\.\.\/runtime\//u.test(source), false);
  assert.equal(/normalizeWindows/u.test(source), false);
  assert.equal(/sha256|createHash/u.test(source), false);
});
