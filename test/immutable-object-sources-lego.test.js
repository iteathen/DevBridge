import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FILES = [
  new URL('../src/runtime/immutable-object-sources/https.js', import.meta.url),
  new URL('../src/runtime/immutable-object-sources/filesystem.js', import.meta.url),
  new URL('../src/runtime/immutable-object-sources/request.js', import.meta.url),
];
const FORBIDDEN = ['GitHub', 'Canonical', 'Ubuntu', 'package', 'apt', 'VM', 'Hyper-V', 'libvirt', 'Git ref', '.devbridge'];

test('immutable object source adapters contain no release, package, provider, or installation identity', async () => {
  for (const file of FILES) {
    const source = await readFile(file, 'utf8');
    for (const term of FORBIDDEN) assert.equal(source.includes(term), false, `${file.pathname} leaked ${term}`);
  }
});
