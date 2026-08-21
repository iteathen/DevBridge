import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFastVmTopology, selectFastVmAddress } from '../src/app/fast-vm-repository-execution.js';

const target = 'env-0123456789abcdef0123456789abcdef';

async function writeProviderState(root) {
  const directory = path.join(root, 'environment-foundation', 'persistent', 'operations');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'state.json'), `${JSON.stringify({
    protocol: 'devbridge/hyperv-persistent-environment-v1',
    records: {
      [target]: {
        identity: target,
        name: 'db-env-fixture',
        marker: 'owned-fixture',
        providerIdentity: '12345678-1234-1234-1234-123456789abc',
      },
    },
  })}\n`);
}

test('fast VM topology resumes without a console and caches the observed endpoint briefly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-fast-vm-topology-'));
  const calls = [];
  try {
    await writeProviderState(root);
    const topology = createFastVmTopology({
      stateDirectory: root,
      invoke: async (request) => {
        calls.push(request);
        return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"state":"running","addresses":["172.18.1.2"],"hostNetworks":[{"address":"172.18.0.1","prefixLength":20}]}', stderr: '' };
      },
      access: async () => ({ family: 'linux', user: 'operator' }),
      cacheMs: 30_000,
    });
    assert.deepEqual(await topology.connection(target), { family: 'linux', user: 'operator', address: '172.18.1.2' });
    assert.deepEqual(await topology.connection(target), { family: 'linux', user: 'operator', address: '172.18.1.2' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'powershell.exe');
    const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
    assert.match(script, /\$state -eq 'Saved'/u);
    assert.match(script, /Resume-VM/u);
    assert.match(script, /Get-NetIPAddress/u);
    assert.doesNotMatch(script, /vmconnect/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fast VM address selection ignores stale guest addresses from a different switch', () => {
  assert.equal(selectFastVmAddress(
    ['192.168.175.179', '172.18.75.118', 'fe80::215:5dff:fe01:e06'],
    [{ address: '172.18.64.1', prefixLength: 20 }],
  ), '172.18.75.118');
  assert.equal(selectFastVmAddress(['192.168.175.179'], [{ address: '172.18.64.1', prefixLength: 20 }]), null);
  assert.equal(selectFastVmAddress(['300.1.1.1'], [{ address: '172.18.64.1', prefixLength: 20 }]), null);
});
