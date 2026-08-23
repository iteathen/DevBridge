import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const GENERIC = [
  new URL('../src/runtime/image-builders/fixed-length-media-patcher.js', import.meta.url),
];
const SOURCE_AND_RECIPE = [
  new URL('../src/runtime/image-sources/ubuntu-release-media.js', import.meta.url),
  new URL('../src/runtime/image-builders/ubuntu-autoinstall-media.js', import.meta.url),
];
const SEED_WRITER = new URL('../src/runtime/providers/windows-imapi-nocloud-seed.js', import.meta.url);

test('generic media patching has no source, guest, provider, or repository identity', async () => {
  for (const source of GENERIC) {
    const text = await readFile(source, 'utf8');
    assert.doesNotMatch(text, /(?:Ubuntu|Canonical|Windows|Hyper-V|libvirt|GitHub|NoCloud|CIDATA)/iu);
  }
});

test('Ubuntu source and recipe adapters do not learn provider or repository identities', async () => {
  for (const source of SOURCE_AND_RECIPE) {
    const text = await readFile(source, 'utf8');
    assert.doesNotMatch(text, /(?:Hyper-V|libvirt|PowerShell|IMAPI|GitHub|VHDX|qcow2)/iu);
  }
});

test('seed media writer does not learn guest distribution or environment identities', async () => {
  const text = await readFile(SEED_WRITER, 'utf8');
  assert.doesNotMatch(text, /(?:Ubuntu|Canonical|Hyper-V|libvirt|repository|workspace|environment)/iu);
});
