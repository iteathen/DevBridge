import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const genericFiles = [
  new URL('../src/runtime/persistent-environments.js', import.meta.url),
  new URL('../src/runtime/environment-foundation.js', import.meta.url),
];

const edgeFiles = [
  new URL('../src/runtime/providers/hyperv-persistent-environment.js', import.meta.url),
  new URL('../src/runtime/providers/libvirt-persistent-environment.js', import.meta.url),
];

test('generic Stage 3 LEGO modules never name concrete attachments or neighboring execution topology', async () => {
  const forbidden = [
    /hyper-?v/iu, /libvirt/iu, /qemu/iu, /powershell/iu, /virsh/iu,
    /repositoryexecution/iu, /workerexchange/iu, /bubblewrap/iu, /appcontainer/iu,
    /owner\/project/iu,
  ];
  for (const file of genericFiles) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file.pathname} leaked ${pattern}`);
  }
});

test('provider-local Stage 3 adapters do not import one another or the persistent registry LEGO', async () => {
  for (const file of edgeFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from ['"].*persistent-environments\.js['"]/u);
  }
  const hyperv = await readFile(edgeFiles[0], 'utf8');
  const libvirt = await readFile(edgeFiles[1], 'utf8');
  assert.doesNotMatch(hyperv, /libvirt/iu);
  assert.doesNotMatch(libvirt, /hyper-?v/iu);
});

test('Stage 3 code does not restore host sandbox or repository execution paths', async () => {
  const files = [...genericFiles, ...edgeFiles, new URL('../src/app/environment-foundation.js', import.meta.url)];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /bubblewrap|appcontainer|sandbox-execution|repository-execution\.js/iu);
  }
});
