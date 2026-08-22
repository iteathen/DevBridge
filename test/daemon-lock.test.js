import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireDaemonLock,
  consumeDaemonStopRequest,
  daemonStatus,
  requestDaemonStop,
  stopDaemon,
} from '../src/runtime/daemon-lock.js';
import { PolicyError } from '../src/errors.js';

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, { timeoutMs = 3000, pollMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error('timed out waiting for daemon lock condition');
}

const inactiveStatus = {
  activeLock: false,
  stopRequested: false,
  pauseRequested: false,
  paused: false,
};

test('daemon lock prevents concurrent ownership and releases only its own token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lock-'));
  const file = path.join(root, 'daemon.lock');
  const release = await acquireDaemonLock(file);
  await assert.rejects(() => acquireDaemonLock(file), PolicyError);
  await release();
  const releaseAgain = await acquireDaemonLock(file);
  await releaseAgain();
});

test('daemon stop request binds to the current lock token and is consumed by its owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lock-stop-'));
  const file = path.join(root, 'daemon.lock');
  const release = await acquireDaemonLock(file);

  assert.deepEqual(await daemonStatus(file), {
    activeLock: true,
    pid: process.pid,
    createdAt: release.record.createdAt,
    stopRequested: false,
    pauseRequested: false,
    paused: false,
  });

  const requested = await requestDaemonStop(file);
  assert.equal(requested.activeLock, true);
  assert.equal(requested.requested, true);
  assert.equal(requested.pid, process.pid);
  assert.equal((await daemonStatus(file)).stopRequested, true);

  assert.equal(await consumeDaemonStopRequest(file, release.record), true);
  assert.equal((await daemonStatus(file)).stopRequested, false);
  await release();
  assert.deepEqual(await daemonStatus(file), inactiveStatus);
});

test('stopDaemon waits for the lock owner to release instead of deleting its lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lock-stop-wait-'));
  const file = path.join(root, 'daemon.lock');
  const release = await acquireDaemonLock(file);

  const stopping = stopDaemon(file, { timeoutMs: 2000, pollMs: 10 });
  await waitUntil(async () => (await daemonStatus(file)).stopRequested, { timeoutMs: 2500, pollMs: 10 });
  assert.equal((await daemonStatus(file)).stopRequested, true);

  assert.equal(await consumeDaemonStopRequest(file, release.record), true);
  await release();
  const result = await stopping;
  assert.equal(result.requested, true);
  assert.equal(result.stopped, true);
  assert.deepEqual(await daemonStatus(file), inactiveStatus);
});
