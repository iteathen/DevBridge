import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = [
  new URL('../src/runtime/https-file-download.js', import.meta.url),
  new URL('../src/runtime/detached-signature-verifier.js', import.meta.url),
];

test('source effect adapters remain vendor, provider, and repository agnostic', async () => {
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  for (const forbidden of [
    /Ubuntu/u,
    /Canonical/u,
    /HyperV/u,
    /libvirt/u,
    /qemu/u,
    /GitHub/u,
    /repository/u,
    /release.?media/iu,
    /product.?key/iu,
    /activation/iu,
  ]) assert.equal(forbidden.test(source), false, `source effect adapter leaked ${forbidden}`);
});
