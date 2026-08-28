import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const genericSource = new URL('../src/runtime/image-builders/canonical-image-canary.js', import.meta.url);
const compositionSource = new URL('../src/runtime/image-builders/production-image-canary-composition.js', import.meta.url);

test('canonical image canary remains isolated from provider, guest, transport, and neighboring implementation identities', async () => {
  const text = await readFile(genericSource, 'utf8');
  for (const forbidden of [
    /hyper-?v/iu,
    /libvirt/iu,
    /\bubuntu\b/iu,
    /\bssh\b/iu,
    /\bvhdx?\b/iu,
    /\bqcow2?\b/iu,
    /\bbridge\b/iu,
    /\bautoinstall\b/iu,
    /\binstaller\b/iu,
    /base-image-library/iu,
    /environment-foundation/iu,
  ]) assert.doesNotMatch(text, forbidden);
});

test('production canary composition is a thin topology edge rather than a concrete provider implementation', async () => {
  const text = await readFile(compositionSource, 'utf8');
  assert.match(text, /canonical-image-canary\.js/u);
  assert.doesNotMatch(text, /providers\//u);
  assert.doesNotMatch(text, /image-sources\//u);
  assert.doesNotMatch(text, /node:child_process/u);
  assert.doesNotMatch(text, /powershell|virsh|qemu|ssh\.exe/iu);
});
