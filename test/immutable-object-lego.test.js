import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FILES = [
  new URL('../src/runtime/immutable-object-set.js', import.meta.url),
  new URL('../src/runtime/immutable-object-acquisition.js', import.meta.url),
];
const FORBIDDEN = [
  'GitHub', 'Canonical', 'Ubuntu', 'Azure', 'S3', 'OCI', 'snapshot.ubuntu.com',
  'package', 'apt', 'VM', 'Hyper-V', 'libvirt', 'Git ref', '.devbridge',
];

test('immutable object children contain no origin, package, provider, or installation identity', async () => {
  for (const file of FILES) {
    const source = await readFile(file, 'utf8');
    for (const term of FORBIDDEN) assert.equal(source.includes(term), false, `${file.pathname} leaked ${term}`);
  }
});
