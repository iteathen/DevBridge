import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const genericFiles = [
  'src/runtime/base-image-library.js',
  'src/runtime/command-invocation.js',
  'src/runtime/environment-foundation.js',
  'src/runtime/local-identity.js',
];

test('generic Stage-2 LEGO modules do not name concrete provider or neighboring execution identities', async () => {
  const forbidden = [/hyper-?v/iu, /libvirt/iu, /qemu/iu, /powershell/iu, /virsh/iu, /repositoryexecution/iu, /workerexchange/iu, /bubblewrap/iu, /appcontainer/iu];
  for (const file of genericFiles) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file} leaked ${pattern}`);
  }
});
