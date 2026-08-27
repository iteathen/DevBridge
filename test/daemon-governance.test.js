import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDaemon } from '../src/app/daemon.js';
import {
  acquireDaemonLock,
  acknowledgeDaemonPause,
  daemonStatus,
  pauseDaemon,
  requestDaemonPause,
  resumeDaemon,
  stopDaemon,
} from '../src/runtime/daemon-lock.js';

const GOVERNANCE_TIMEOUT_MS = 10_000;
const GOVERNANCE_POLL_MS = 10;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, { timeoutMs = GOVERNANCE_TIMEOUT_MS, pollMs = GOVERNANCE_POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(pollMs);
  }
  throw new Error('timed out waiting for daemon governance condition');
}

function startTestDaemon(context, config, options = {}) {
  const controller = new AbortController();
  const running = runDaemon(config, { ...options, signal: controller.signal });
  let cleanupPromise = null;
  const cleanup = () => {
    if (cleanupPromise == null) {
      controller.abort();
      cleanupPromise = running;
    }
    return cleanupPromise;
  };
  context.after(cleanup, { timeout: GOVERNANCE_TIMEOUT_MS });
  return Object.freeze({ cleanup, running });
}

function governanceWait() {
  return { timeoutMs: GOVERNANCE_TIMEOUT_MS, pollMs: GOVERNANCE_POLL_MS };
}

function daemonConfig(stateDirectory) {
  return {
    state: { directory: stateDirectory },
    github: { pollIntervalMs: 15_000 },
    daemon: { errorBackoffMs: 5_000 },
  };
}

function idleRuntime(config, counter) {
  return {
    config: { ...config, execution: { enabled: false } },
    toolInventory: null,
    toolOnboarding: null,
    rateBudget: {
      recommendedPollIntervalMs(value) {
        counter.cycles += 1;
        return value;
      },
      snapshot() { return {}; },
    },
  };
}

test('pause and resume records bind to the current daemon lock token', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-daemon-governance-lock-'));
  const file = path.join(root, 'daemon.lock');
  const release = await acquireDaemonLock(file);
  t.after(release, { timeout: GOVERNANCE_TIMEOUT_MS });

  const request = await requestDaemonPause(file);
  assert.equal(request.requested, true);
  assert.deepEqual(await daemonStatus(file), {
    activeLock: true,
    pid: process.pid,
    createdAt: release.record.createdAt,
    stopRequested: false,
    pauseRequested: true,
    paused: false,
  });

  assert.equal(await acknowledgeDaemonPause(file, release.record), true);
  assert.equal((await daemonStatus(file)).paused, true);

  const resuming = resumeDaemon(file, governanceWait());
  await waitUntil(async () => !(await daemonStatus(file)).pauseRequested);
  await release();
  const result = await resuming;
  assert.equal(result.resumed, true);
  assert.equal(result.activeLock, false);
  assert.deepEqual(await daemonStatus(file), {
    activeLock: false,
    stopRequested: false,
    pauseRequested: false,
    paused: false,
  });
});

test('daemon acknowledges pause only at a cycle boundary and performs no new cycle until resume', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-daemon-governance-'));
  const config = daemonConfig(root);
  const lockPath = path.join(root, 'daemon.lock');
  const counter = { cycles: 0 };
  const events = [];
  const { running } = startTestDaemon(t, config, {
    runtimeFactory: async () => idleRuntime(config, counter),
    onEvent: (event) => events.push(event.type),
  });

  await waitUntil(() => counter.cycles >= 1);
  const pausing = pauseDaemon(lockPath, governanceWait());
  const paused = await pausing;
  assert.equal(paused.paused, true);
  const atPause = counter.cycles;
  assert.equal((await daemonStatus(lockPath)).paused, true);
  await delay(100);
  assert.equal(counter.cycles, atPause);
  assert.ok(events.includes('daemon-paused'));

  const resumed = await resumeDaemon(lockPath, governanceWait());
  assert.equal(resumed.resumed, true);
  await waitUntil(() => counter.cycles > atPause);
  assert.ok(events.includes('daemon-resumed'));

  const stopping = stopDaemon(lockPath, governanceWait());
  await running;
  assert.equal((await stopping).stopped, true);
});

test('stop wins while paused and the daemon releases its lock without requiring resume', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-daemon-governance-stop-'));
  const config = daemonConfig(root);
  const lockPath = path.join(root, 'daemon.lock');
  const counter = { cycles: 0 };
  const { running } = startTestDaemon(t, config, {
    runtimeFactory: async () => idleRuntime(config, counter),
  });

  await waitUntil(() => counter.cycles >= 1);
  assert.equal((await pauseDaemon(lockPath, governanceWait())).paused, true);
  const stopped = stopDaemon(lockPath, governanceWait());
  await running;
  assert.equal((await stopped).stopped, true);
  assert.equal((await daemonStatus(lockPath)).activeLock, false);
});

test('registered cleanup preserves a primary failure before normal stop and releases the exact daemon lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-daemon-governance-cleanup-'));
  const config = daemonConfig(root);
  const lockPath = path.join(root, 'daemon.lock');
  const counter = { cycles: 0 };
  const handle = startTestDaemon(t, config, {
    runtimeFactory: async () => idleRuntime(config, counter),
  });

  await waitUntil(() => counter.cycles >= 1);
  const primary = new Error('simulated governance assertion failure');
  await assert.rejects(async () => {
    try {
      throw primary;
    } finally {
      await handle.cleanup();
    }
  }, (error) => error === primary);
  assert.equal((await daemonStatus(lockPath)).activeLock, false);
  await handle.cleanup();
});
