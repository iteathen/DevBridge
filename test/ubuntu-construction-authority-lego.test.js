import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const domainFiles = [
  new URL('../src/runtime/image-builders/ubuntu-construction-authority.js', import.meta.url),
  new URL('../src/runtime/image-builders/ubuntu-construction-authority-catalog.js', import.meta.url),
];

test('Ubuntu construction authority does not acquire provider, repository, or secret-store identity', async () => {
  const source = (await Promise.all(domainFiles.map((file) => readFile(file, 'utf8')))).join('\n');
  for (const forbidden of [
    /HyperV/u,
    /libvirt/u,
    /qemu/u,
    /GitHub/u,
    /repository[A-Z]/u,
    /product.?key/iu,
    /DPAPI/u,
    /activation/u,
    /Codex/u,
    /Aider/u,
    /CUDA/u,
  ]) assert.equal(forbidden.test(source), false, `construction authority leaked ${forbidden}`);
});

test('construction authority persistence stays a thin state adapter', async () => {
  const source = await readFile(new URL('../src/state/ubuntu-construction-authority-state-store.js', import.meta.url), 'utf8');
  assert.equal(/\.\.\/runtime\//u.test(source), false);
  assert.equal(/normalizeUbuntu/u.test(source), false);
  assert.equal(/sha256|createHash/u.test(source), false);
});

test('guest payload owner does not acquire image-source or provider topology identity', async () => {
  const source = await readFile(new URL('../src/guest/image-payload.js', import.meta.url), 'utf8');
  for (const forbidden of [/Ubuntu/u, /HyperV/u, /libvirt/u, /GitHub/u, /repository/u, /release.?media/iu]) {
    assert.equal(forbidden.test(source), false, `guest payload leaked ${forbidden}`);
  }
});
