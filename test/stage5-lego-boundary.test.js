import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const core = new URL('../src/runtime/environment-bootstrap.js', import.meta.url);
const guest = new URL('../src/guest/environment-bootstrap-agent.mjs', import.meta.url);
const hyperv = new URL('../src/runtime/providers/hyperv-environment-bootstrap.js', import.meta.url);
const libvirt = new URL('../src/runtime/providers/libvirt-environment-bootstrap.js', import.meta.url);
const seed = new URL('../src/guest/network-seed-agent.mjs', import.meta.url);
const composition = new URL('../src/app/environment-bootstrap.js', import.meta.url);

test('generic bootstrap LEGO names only its local contract', async () => {
  const source = await readFile(core, 'utf8');
  const forbidden = [
    /hyper-?v/iu, /libvirt/iu, /qemu/iu, /powershell/iu, /virsh/iu, /\bssh\b/iu,
    /environment-bridge/iu, /environment-foundation/iu, /persistent-environment/iu,
    /repository-execution/iu, /worker-exchange/iu, /bubblewrap/iu, /appcontainer/iu, /processcontainer/iu,
    /['"`]git['"`]/iu, /['"`]node(?:\.exe)?['"`]/iu, /['"`]cmake['"`]/iu, /['"`]ctest['"`]/iu, /['"`]npm['"`]/iu,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `generic bootstrap leaked ${pattern}`);
  assert.doesNotMatch(source, /from ['"].*providers\//u);
});

test('provider-local bootstrap attachments do not name or import the other provider family', async () => {
  const left = await readFile(hyperv, 'utf8');
  const right = await readFile(libvirt, 'utf8');
  assert.doesNotMatch(left, /libvirt|qemu|virsh|qcow/iu);
  assert.doesNotMatch(right, /hyper-?v|powershell|\bvhdx?\b/iu);
  assert.doesNotMatch(left, /:persistent:|db-env-/iu);
  assert.doesNotMatch(right, /:persistent:|db-env-/iu);
  assert.doesNotMatch(left, /\bkvp\b|AddKvpItems|ModifyKvpItems/iu);
  assert.doesNotMatch(left, /from ['"].*libvirt/u);
  assert.doesNotMatch(right, /from ['"].*hyperv/u);
});

test('guest bootstrap helper contains no provider or host-topology vocabulary', async () => {
  const source = await readFile(guest, 'utf8');
  for (const pattern of [/hyper-?v/iu, /libvirt/iu, /qemu/iu, /virsh/iu, /repository-execution/iu, /bubblewrap/iu, /appcontainer/iu, /processcontainer/iu]) {
    assert.doesNotMatch(source, pattern, `guest bootstrap leaked ${pattern}`);
  }
});

test('guest network seed helper contains no host-provider topology vocabulary', async () => {
  const source = await readFile(seed, 'utf8');
  for (const pattern of [/hyper-?v/iu, /libvirt/iu, /qemu/iu, /virsh/iu, /repository-execution/iu, /bubblewrap/iu, /appcontainer/iu, /processcontainer/iu]) {
    assert.doesNotMatch(source, pattern, `guest network seed leaked ${pattern}`);
  }
});

test('Stage 5 composition is the topology edge and does not reconnect production repository routing', async () => {
  const source = await readFile(composition, 'utf8');
  assert.match(source, /hyperv-environment-bootstrap\.js/u);
  assert.match(source, /libvirt-environment-bootstrap\.js/u);
  assert.match(source, /environment-bridge\.js/u);
  assert.match(source, /environment-foundation\.js/u);
  assert.doesNotMatch(source, /repository-execution\.js|bubblewrap|appcontainer|processcontainer/iu);
  try {
    const runtime = await readFile(new URL('../src/app/runtime.js', import.meta.url), 'utf8');
    assert.doesNotMatch(runtime, /environment-bootstrap\.js/iu);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
});
