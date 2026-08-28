import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activityLeaseHolderReadyLine } from '../src/runtime/activity-lease-protocol.js';
import { createLinuxFileLease } from '../src/runtime/linux-file-lease.js';

const FAST = Object.freeze({ sharedAcquireMs: 100, exclusiveAcquireMs: 100, releaseMs: 50, killMs: 20 });

function fakeProcess({ outcome = 'ready', closeOnEnd = true, closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kills = [];
  let closed = false;
  const close = (code, signal = null) => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => child.emit('close', code, signal));
  };
  child.stdin.end = () => { if (closeOnEnd && outcome === 'ready') close(0); };
  child.kill = (signal) => {
    child.kills.push(signal);
    if (closeOnKill) close(null, signal);
    return true;
  };
  queueMicrotask(() => {
    if (outcome === 'ready') child.stdout.emit('data', activityLeaseHolderReadyLine());
    else if (outcome === 'conflict') close(75);
    else if (outcome === 'malformed') child.stdout.emit('data', '{"ready":false}\n');
    else if (outcome === 'stderr') child.stderr.emit('data', 'foreign diagnostic');
  });
  return { child, close };
}

function fixture(processOptions = {}) {
  const calls = [];
  const created = [];
  const spawnProcess = (...args) => {
    calls.push(args);
    const next = fakeProcess(processOptions);
    created.push(next);
    return next.child;
  };
  return {
    calls,
    created,
    lease: createLinuxFileLease({ subjectPath: '/run/devbridge/test/governance/activity.lock' }, { spawnProcess, timingPolicy: FAST }),
  };
}

test('shared acquisition uses only fixed no-shell nonblocking argv and stripped environment', async () => {
  const values = fixture();
  const held = await values.lease.acquire({ mode: 'shared', signal: null });
  const [executable, args, options] = values.calls[0];
  assert.equal(executable, '/usr/bin/flock');
  assert.deepEqual(args.slice(0, 6), ['--no-fork', '--shared', '--nonblock', '--conflict-exit-code', '75', '--']);
  assert.equal(args[6], '/run/devbridge/test/governance/activity.lock');
  assert.equal(args[7], process.execPath);
  assert.match(args[8], /activity-lease-holder\.mjs$/u);
  assert.deepEqual(options, {
    stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: { LANG: 'C', LC_ALL: 'C' },
  });
  await held.release();
});

test('exclusive acquisition uses one fixed bounded flock timeout', async () => {
  const values = fixture();
  const held = await values.lease.acquire({ mode: 'exclusive', signal: null });
  assert.deepEqual(values.calls[0][1].slice(0, 7), ['--no-fork', '--exclusive', '--timeout', '30', '--conflict-exit-code', '75', '--']);
  await held.release();
});

test('contention and cancellation return no lease only after process closure', async () => {
  const conflict = fixture({ outcome: 'conflict' });
  assert.equal(await conflict.lease.acquire({ mode: 'shared', signal: null }), null);

  let invoked = false;
  const aborted = new AbortController();
  aborted.abort();
  const lease = createLinuxFileLease({ subjectPath: '/run/devbridge/test/governance/activity.lock' }, {
    timingPolicy: FAST,
    spawnProcess: () => { invoked = true; throw new Error('must not start'); },
  });
  assert.equal(await lease.acquire({ mode: 'exclusive', signal: aborted.signal }), null);
  assert.equal(invoked, false);

  const active = fixture({ outcome: 'pending' });
  const controller = new AbortController();
  const acquiring = active.lease.acquire({ mode: 'exclusive', signal: controller.signal });
  controller.abort();
  assert.equal(await acquiring, null);
  assert.deepEqual(active.created[0].child.kills, ['SIGTERM']);
});

test('malformed, stderr, and oversized readiness evidence fail closed and terminate', async () => {
  for (const outcome of ['malformed', 'stderr']) {
    const values = fixture({ outcome });
    await assert.rejects(() => values.lease.acquire({ mode: 'shared', signal: null }), /Linux file lease process/u);
    assert.deepEqual(values.created[0].child.kills, ['SIGTERM']);
  }
  const values = fixture({ outcome: 'pending' });
  const acquiring = values.lease.acquire({ mode: 'shared', signal: null });
  values.created[0].child.stdout.emit('data', 'x'.repeat(4097));
  await assert.rejects(() => acquiring, /output exceeded/u);
});

test('unexpected holder death and bounded release failure are observable', async () => {
  const lost = fixture();
  const held = await lost.lease.acquire({ mode: 'shared', signal: null });
  lost.created[0].close(9);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => held.release(), /ended unexpectedly/u);

  const stuck = fixture({ closeOnEnd: false, closeOnKill: true });
  const stuckHeld = await stuck.lease.acquire({ mode: 'exclusive', signal: null });
  await assert.rejects(() => stuckHeld.release(), /did not release in time/u);
  assert.deepEqual(stuck.created[0].child.kills, ['SIGTERM']);

  const unobservable = fixture({ closeOnEnd: false, closeOnKill: false });
  const unobservableHeld = await unobservable.lease.acquire({ mode: 'exclusive', signal: null });
  await assert.rejects(() => unobservableHeld.release(), /did not release in time/u);
  assert.deepEqual(unobservable.created[0].child.kills, ['SIGTERM', 'SIGKILL']);

  const neverReady = fixture({ outcome: 'pending', closeOnKill: false });
  await assert.rejects(() => neverReady.lease.acquire({ mode: 'shared', signal: null }), /did not complete in time/u);
  assert.deepEqual(neverReady.created[0].child.kills, ['SIGTERM', 'SIGKILL']);
});

test('adapter rejects topology/contract widening before spawning', async () => {
  assert.throws(() => createLinuxFileLease({ subjectPath: 'relative' }), /normalized absolute/u);
  assert.throws(() => createLinuxFileLease({ subjectPath: '/run/x', executable: '/foreign' }), /unknown field/u);
  const values = fixture();
  await assert.rejects(() => values.lease.acquire({ mode: 'shared', command: 'foreign' }), /unknown field/u);
  assert.equal(values.calls.length, 0);
});

test('real Linux flock canary proves shared and exclusive holder execution', { skip: process.platform !== 'linux' }, async () => {
  await access('/usr/bin/flock', constants.X_OK);
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-file-lease-'));
  const subject = path.join(root, 'activity.lock');
  try {
    await writeFile(subject, '');
    const lease = createLinuxFileLease({ subjectPath: subject });
    const first = await lease.acquire({ mode: 'shared', signal: null });
    const second = await lease.acquire({ mode: 'shared', signal: null });
    assert.notEqual(first, null);
    assert.notEqual(second, null);
    await second.release();
    await first.release();
    const exclusive = await lease.acquire({ mode: 'exclusive', signal: null });
    assert.notEqual(exclusive, null);
    await exclusive.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
