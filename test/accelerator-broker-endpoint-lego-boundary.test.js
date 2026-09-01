import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const attachmentUrl = new URL('../src/runtime/accelerator-broker-endpoint-attachment.js', import.meta.url);
const serviceUrl = new URL('../src/runtime/accelerator-broker-service.js', import.meta.url);
const windowsUrl = new URL('../src/runtime/providers/windows-hyperv-accelerator-broker-endpoint.js', import.meta.url);
const linuxUrl = new URL('../src/runtime/providers/libvirt-vsock-accelerator-broker-endpoint.js', import.meta.url);

test('neutral #418 service remains independent of provider endpoint mechanics', async () => {
  const source = (await readFile(serviceUrl, 'utf8')).toLowerCase();
  for (const forbidden of ['hyperv', 'hyper-v', 'libvirt', 'vsock', 'guestcid', 'vmid', 'serviceid', 'endpoint-attachment']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('shared endpoint attachment owns no provider listener, process, filesystem, or VM lifecycle authority', async () => {
  const source = (await readFile(attachmentUrl, 'utf8')).toLowerCase();
  for (const forbidden of [
    'hyperv', 'hyper-v', 'libvirt', 'af_vsock', 'af_hyperv', 'node:net', 'node:fs', 'node:child_process',
    'spawn(', 'exec(', 'powershell', 'systemctl', 'virsh', 'get-vm', 'registry', 'guestcommunicationservices',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes('decodeAcceleratorBrokerServiceRequestFrame'), true);
  assert.equal(source.includes('matchAcceleratorBrokerBinding'), true);
  assert.equal(source.includes('encodeAcceleratorBrokerServiceResponseFrame'), true);
});

test('provider endpoint adapters own peer policy but no native acquisition or general bridge surface', async () => {
  for (const url of [windowsUrl, linuxUrl]) {
    const source = (await readFile(url, 'utf8')).toLowerCase();
    for (const forbidden of [
      'node:net', 'node:fs', 'node:child_process', 'spawn(', 'exec(', 'powershell', 'systemctl', 'virsh',
      'environment-bridge', 'repository-execution', 'hostpath', 'workingdirectory', 'command', 'credential',
    ]) {
      assert.equal(source.includes(forbidden), false, `${url.pathname}:${forbidden}`);
    }
    assert.equal(source.includes('accelerator-broker-endpoint-attachment.js'), true);
  }
});

test('provider identities do not flow back into the sealed broker service module', async () => {
  const service = await readFile(serviceUrl, 'utf8');
  const attachment = await readFile(attachmentUrl, 'utf8');
  assert.equal(service.includes('windows-hyperv-accelerator-broker-endpoint'), false);
  assert.equal(service.includes('libvirt-vsock-accelerator-broker-endpoint'), false);
  assert.equal(attachment.includes('windows-hyperv-accelerator-broker-endpoint'), false);
  assert.equal(attachment.includes('libvirt-vsock-accelerator-broker-endpoint'), false);
});
