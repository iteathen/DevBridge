import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const agent = new URL('../src/guest/network-seed-agent.mjs', import.meta.url);

async function runOnce(seed) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-network-seed-'));
  const seedFile = path.join(root, 'seed.json');
  const stateFile = path.join(root, 'state.json');
  await writeFile(seedFile, JSON.stringify(seed));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [agent.pathname, '--once'], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, DEVBRIDGE_NETWORK_SEED: seedFile, DEVBRIDGE_NETWORK_STATE: stateFile },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', async (code) => {
      await rm(root, { recursive: true, force: true });
      resolve({ code, stderr });
    });
  });
}

test('network seed rejects path/topology-shaped invalid network data before any configuration effect', async () => {
  const result = await runOnce({
    protocol: 'devbridge/network-seed-v1',
    target: 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    address: '../host',
    prefixLength: 24,
    gateway: '192.168.1.1',
    dns: ['1.1.1.1'],
    revision: 1,
  });
  assert.notEqual(result.code, 0);
});
