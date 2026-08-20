import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFastPersistentEnvironmentChannel } from '../src/app/fast-persistent-environment-channel.js';

const agent = fileURLToPath(new URL('../src/guest/bridge-agent.mjs', import.meta.url));
const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('fast persistent channel reuses one ordered guest connection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-fast-persistent-channel-'));
  const guest = path.join(root, 'guest');
  const identityFile = path.join(root, 'identity');
  const knownHostsFile = path.join(root, 'known-hosts');
  const children = [];
  let starts = 0;
  try {
    await mkdir(guest);
    await writeFile(identityFile, 'fixture');
    await writeFile(knownHostsFile, 'fixture');
    const channel = createFastPersistentEnvironmentChannel({
      access: async () => ({ family: 'linux', user: 'operator', address: 'fixture.local', identityFile, knownHostsFile }),
      spawnProcess: (_executable, _arguments, options) => {
        starts += 1;
        const child = spawn(process.execPath, [agent, '--exchange-lines'], {
          ...options,
          env: { ...process.env, DEVBRIDGE_GUEST_BRIDGE_ROOT: guest, DEVBRIDGE_GUEST_TARGET: target },
        });
        children.push(child);
        return child;
      },
    });
    const [first, second] = await Promise.all([channel.health(target), channel.health(target)]);
    assert.equal(first.ready, true);
    assert.equal(second.ready, true);
    assert.equal(starts, 1);
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
});
