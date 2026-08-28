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

test('Windows media persistence remains a set of thin state adapters', async () => {
  for (const file of [
    '../src/state/windows-install-media-authority-state-store.js',
    '../src/state/windows-install-media-selection-state-store.js',
    '../src/state/windows-install-media-source-state-store.js',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.equal(/\.\.\/runtime\//u.test(source), false, file);
    assert.equal(/normalizeWindows/u.test(source), false, file);
    assert.equal(/sha256|createHash/u.test(source), false, file);
  }
});

test('Windows media setup selection and source adapter retain replaceable local studs', async () => {
  const selection = await readFile(new URL('../src/setup/windows-install-media-selection.js', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/runtime/image-sources/windows-install-media-source.js', import.meta.url), 'utf8');
  assert.doesNotMatch(selection, /image-builders|image-sources|provider|hyper-?v|repository|guest|virtual.?machine/iu);
  assert.doesNotMatch(source, /windows-install-media-inspector|image-builder|provider|hyper-?v|repository|guest|virtual.?machine/iu);
  assert.match(selection, /normalizeInventory/u);
  assert.match(selection, /createAuthority/u);
  assert.match(source, /inspectorFactory/u);
});
