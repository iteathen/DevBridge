import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireDaemonLock,
  consumeDaemonStopRequest,
  daemonStatus,
  reconcileDeadDaemonLock,
  reconcileExitedDaemonLock,
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

test('supervisor reconciliation removes only an exact exited-child lock generation and its controls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lock-exited-'));
  const file = path.join(root, 'daemon.lock');
  const token = '12345678-1234-1234-1234-123456789abc';
  const pid = 424242;
  const spawnedAt = Date.now() - 1000;
  const createdAt = new Date().toISOString();
  await writeFile(file, `${JSON.stringify({ protocol: 'devbridge/daemon-lock-v1', pid, token, createdAt })}\n`);
  await writeFile(`${file}.stop-${token}`, `${JSON.stringify({
    protocol: 'devbridge/daemon-stop-v1', pid, token, requestedAt: new Date().toISOString(),
  })}\n`);

  await assert.rejects(
    reconcileExitedDaemonLock(file, { pid: pid + 1, spawnedAt }),
    /different process/u,
  );
  await access(file);
  await assert.rejects(
    reconcileExitedDaemonLock(file, { pid, spawnedAt: Date.now() + 60_000 }),
    /predates/u,
  );
  await access(file);

  const result = await reconcileExitedDaemonLock(file, { pid, spawnedAt });
  assert.equal(result.reconciled, true);
  assert.equal(result.pid, pid);
  await assert.rejects(access(file), /ENOENT/u);
  await assert.rejects(access(`${file}.stop-${token}`), /ENOENT/u);
  assert.deepEqual(await reconcileExitedDaemonLock(file, { pid, spawnedAt }), { reconciled: false, reason: 'absent' });
});

test('dead daemon reconciliation requires exclusive supervisor ownership and preserves a live generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lock-dead-'));
  const file = path.join(root, 'daemon.lock');
  const token = '12345678-1234-1234-1234-123456789abc';
  const record = { protocol: 'devbridge/daemon-lock-v1', pid: 424242, token, createdAt: new Date().toISOString() };
  await writeFile(file, `${JSON.stringify(record)}\n`);
  await writeFile(`${file}.stop-${token}`, `${JSON.stringify({
    protocol: 'devbridge/daemon-stop-v1', pid: record.pid, token, requestedAt: new Date().toISOString(),
  })}\n`);

  await assert.rejects(reconcileDeadDaemonLock(file, { isProcessAlive: () => false }), /exclusive supervisor ownership/u);
  assert.deepEqual(
    await reconcileDeadDaemonLock(file, { exclusiveSupervisorOwned: true, isProcessAlive: () => true }),
    { reconciled: false, reason: 'live', pid: record.pid },
  );
  await access(file);

  const result = await reconcileDeadDaemonLock(file, { exclusiveSupervisorOwned: true, isProcessAlive: () => false });
  assert.equal(result.reconciled, true);
  assert.equal(result.token, token);
  await assert.rejects(access(file), /ENOENT/u);
  await assert.rejects(access(`${file}.stop-${token}`), /ENOENT/u);
});
