import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createConfiguredEnvironmentActivityClient,
  createEnvironmentActivitySocketServer,
  environmentActivityAuthorityEndpoint,
  environmentActivityAuthorityIdentity,
} from '../src/runtime/environment-activity-authority-transport.js';

function activity() {
  return {
    async inspect() { return { ready: true, identity: 'foundation-a' }; },
    async list() { return []; },
    async observe() { throw new Error('unexpected'); },
    async prepare() { throw new Error('unexpected'); },
    async exchange() { throw new Error('unexpected'); },
  };
}

async function provisionEndpoint(state, run, platform) {
  if (platform !== 'linux') return;
  const identity = environmentActivityAuthorityIdentity(state, { platform });
  const endpoint = environmentActivityAuthorityEndpoint({ authorityIdentity: identity, platform, runDirectory: run });
  await mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
}

test('activity endpoint identity is deterministic, local, and distinct by access purpose', () => {
  const windowsA = environmentActivityAuthorityIdentity('C:\\DevBridge\\State', { platform: 'win32' });
  const windowsB = environmentActivityAuthorityIdentity('c:\\devbridge\\state\\', { platform: 'win32' });
  assert.equal(windowsA, windowsB);
  assert.equal(environmentActivityAuthorityEndpoint({ authorityIdentity: windowsA, platform: 'win32' }), `\\\\.\\pipe\\devbridge-environment-${windowsA}-activity-v1`);
  const linux = environmentActivityAuthorityIdentity('/srv/devbridge/state/', { platform: 'linux' });
  assert.equal(environmentActivityAuthorityEndpoint({ authorityIdentity: linux, platform: 'linux', runDirectory: '/run/devbridge' }), `/run/devbridge/${linux}/activity/environment-v1.sock`);
  assert.throws(() => environmentActivityAuthorityIdentity('relative/state', { platform: 'linux' }), /must be absolute/u);
});

test('configured activity client exchanges through the bounded local endpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-activity-transport-'));
  const state = path.join(root, 'state');
  const run = path.join(root, 'run');
  const platform = process.platform;
  const server = createEnvironmentActivitySocketServer({ activity: activity(), stateDirectory: state, platform, runDirectory: run });
  try {
    await provisionEndpoint(state, run, platform);
    await server.start();
    const client = createConfiguredEnvironmentActivityClient({ stateDirectory: state, platform, runDirectory: run });
    assert.deepEqual(await client.inspect(), { ready: true, identity: 'foundation-a', reason: null });
    assert.deepEqual(await client.list(), []);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('activity transport rejects a second frame and fails closed after shutdown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-activity-transport-'));
  const state = path.join(root, 'state');
  const run = path.join(root, 'run');
  const platform = process.platform;
  const server = createEnvironmentActivitySocketServer({ activity: activity(), stateDirectory: state, platform, runDirectory: run });
  try {
    await provisionEndpoint(state, run, platform);
    await server.start();
    const client = createConfiguredEnvironmentActivityClient({ stateDirectory: state, platform, runDirectory: run, connectTimeoutMs: 500 });
    assert.equal((await client.inspect()).ready, true);
    await server.close();
    await assert.rejects(() => client.inspect(), /environment activity authority is unavailable/u);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
