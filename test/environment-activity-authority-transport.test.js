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
import { ENVIRONMENT_BRIDGE_PROTOCOL } from '../src/runtime/environment-bridge.js';

function activity() {
  return {
    async inspect() { return { ready: true, identity: 'foundation-a' }; },
    async list() { return []; },
    async observe() { throw new Error('unexpected'); },
    async prepare() { throw new Error('unexpected'); },
    async exchange() { throw new Error('unexpected'); },
  };
}

function bridgeFrame(request = 'a'.repeat(32)) {
  return {
    protocol: ENVIRONMENT_BRIDGE_PROTOCOL,
    request,
    target: 'environment-logical',
    kind: 'health',
    body: {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((selectedResolve, selectedReject) => {
    resolve = selectedResolve;
    reject = selectedReject;
  });
  return { promise, resolve, reject };
}

async function within(promise, message, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cancellableActivity(started, aborted) {
  return {
    ...activity(),
    async exchange(_frame, { signal = null } = {}) {
      started.resolve();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          aborted.resolve();
          reject(new Error('protected activity was interrupted'));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    },
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

test('activity transport propagates caller cancellation into the protected handler', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-activity-cancel-'));
  const state = path.join(root, 'state');
  const run = path.join(root, 'run');
  const platform = process.platform;
  const started = deferred();
  const aborted = deferred();
  const server = createEnvironmentActivitySocketServer({
    activity: cancellableActivity(started, aborted),
    stateDirectory: state,
    platform,
    runDirectory: run,
    operationTimeoutMs: 5000,
  });
  try {
    await provisionEndpoint(state, run, platform);
    await server.start();
    const client = createConfiguredEnvironmentActivityClient({
      stateDirectory: state,
      platform,
      runDirectory: run,
      exchangeTimeoutMs: 5000,
    });
    const controller = new AbortController();
    const pending = client.exchange(bridgeFrame(), { signal: controller.signal });
    await within(started.promise, 'protected activity did not start');
    controller.abort();
    await assert.rejects(() => pending, /environment activity authority is unavailable/u);
    await within(aborted.promise, 'protected activity did not observe caller cancellation');
    assert.equal((await client.inspect()).ready, true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('activity client exchange deadline aborts the protected handler after connection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-activity-client-timeout-'));
  const state = path.join(root, 'state');
  const run = path.join(root, 'run');
  const platform = process.platform;
  const started = deferred();
  const aborted = deferred();
  const server = createEnvironmentActivitySocketServer({
    activity: cancellableActivity(started, aborted),
    stateDirectory: state,
    platform,
    runDirectory: run,
    operationTimeoutMs: 5000,
  });
  try {
    await provisionEndpoint(state, run, platform);
    await server.start();
    const client = createConfiguredEnvironmentActivityClient({
      stateDirectory: state,
      platform,
      runDirectory: run,
      exchangeTimeoutMs: 100,
    });
    const pending = client.exchange(bridgeFrame('b'.repeat(32)));
    await within(started.promise, 'protected activity did not start');
    await assert.rejects(() => pending, /environment activity authority is unavailable/u);
    await within(aborted.promise, 'protected activity did not observe the client exchange deadline');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('activity server operation deadline aborts a hung handler and remains usable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-activity-server-timeout-'));
  const state = path.join(root, 'state');
  const run = path.join(root, 'run');
  const platform = process.platform;
  const started = deferred();
  const aborted = deferred();
  const server = createEnvironmentActivitySocketServer({
    activity: cancellableActivity(started, aborted),
    stateDirectory: state,
    platform,
    runDirectory: run,
    operationTimeoutMs: 100,
  });
  try {
    await provisionEndpoint(state, run, platform);
    await server.start();
    const client = createConfiguredEnvironmentActivityClient({
      stateDirectory: state,
      platform,
      runDirectory: run,
      exchangeTimeoutMs: 5000,
    });
    const pending = client.exchange(bridgeFrame('c'.repeat(32)));
    await within(started.promise, 'protected activity did not start');
    await assert.rejects(() => pending, /environment activity authority is unavailable/u);
    await within(aborted.promise, 'protected activity did not observe the server operation deadline');
    assert.equal((await client.inspect()).ready, true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
