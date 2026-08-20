import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFastVmTopology } from '../src/app/fast-vm-repository-execution.js';

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
        return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"state":"running","addresses":["172.18.1.2"]}', stderr: '' };
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
    assert.doesNotMatch(script, /vmconnect/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
