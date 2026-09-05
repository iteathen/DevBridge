import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const genericFiles = [
  new URL('../src/runtime/environment-bridge.js', import.meta.url),
  new URL('../src/guest/activity-store.mjs', import.meta.url),
  new URL('../src/guest/bridge-agent.mjs', import.meta.url),
  new URL('../src/guest/local-process.mjs', import.meta.url),
  new URL('../src/guest/transfer-channel.mjs', import.meta.url),
];
const edgeFiles = [
  new URL('../src/runtime/providers/hyperv-environment-bridge.js', import.meta.url),
  new URL('../src/runtime/providers/libvirt-environment-bridge.js', import.meta.url),
];

test('generic Stage 4 LEGO modules do not name provider or neighboring execution topology', async () => {
  const forbidden = [
    /hyper-?v/iu, /libvirt/iu, /qemu/iu, /powershell/iu, /virsh/iu, /\bssh\b/iu,
    /\bvhdx?\b/iu, /qcow/iu, /repositoryexecution/iu, /repository-execution/iu,
    /workerexchange/iu, /worker-exchange/iu, /\bworker\b/iu, /mailbox/iu,
    /bubblewrap/iu, /appcontainer/iu, /processcontainer/iu,
  ];
  for (const file of genericFiles) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file.pathname} leaked ${pattern}`);
  }
});

test('durable guest execution state contains no process locator identity', async () => {
  for (const file of genericFiles.slice(1)) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /monitorPid|childPid/iu);
  }
});

test('nested guest effect owners remain sibling-agnostic', async () => {
  const localProcess = await readFile(new URL('../src/guest/local-process.mjs', import.meta.url), 'utf8');
  const transfer = await readFile(new URL('../src/guest/transfer-channel.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(localProcess, /transfer|location|request|target|ledger/iu);
  assert.doesNotMatch(transfer, /child_process|spawn\(|activity|cancell|execution|operation/iu);
});

test('provider-local Stage 4 attachments do not name or import the other provider family', async () => {
  const hyperv = await readFile(edgeFiles[0], 'utf8');
  const libvirt = await readFile(edgeFiles[1], 'utf8');
  assert.doesNotMatch(hyperv, /libvirt|qemu|virsh|qcow/iu);
  assert.doesNotMatch(libvirt, /hyper-?v|powershell|\bvhdx?\b/iu);
  assert.doesNotMatch(hyperv, /createHash|:persistent:/u);
  assert.doesNotMatch(libvirt, /createHash|:persistent:/u);
  assert.doesNotMatch(hyperv, /from ['"].*libvirt-environment-bridge\.js['"]/u);
  assert.doesNotMatch(libvirt, /from ['"].*hyperv-environment-bridge\.js['"]/u);
});

test('Stage 4 implementation does not reconnect production repository execution or legacy host isolation', async () => {
  const files = [...genericFiles, ...edgeFiles, new URL('../src/app/environment-bridge.js', import.meta.url)];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /bubblewrap|appcontainer|processcontainer|repository-execution\.js/iu);
  }
  try {
    const runtime = await readFile(new URL('../src/app/runtime.js', import.meta.url), 'utf8');
    assert.doesNotMatch(runtime, /environment-bridge\.js/iu);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
});
