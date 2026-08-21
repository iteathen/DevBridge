import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  decideSupervisorAction,
  remoteBranchHead,
  superviseDaemon,
} from '../src/bootstrap/transactional-bootstrap.mjs';

const paths = {
  home: '/managed',
  runtime: '/managed/runtime',
  runtimeCandidates: '/managed/runtime-candidates',
  activationStateFile: '/managed/runtime-activation.json',
  config: '/operator/config.json',
};
const runtimeA = {
  head: 'a'.repeat(40),
  ref: 'main',
  cliPath: '/managed/runtime/src/cli.js',
  runtimeDir: '/managed/runtime',
  version: '0.1.0',
};
const runtimeB = {
  ...runtimeA,
  head: 'b'.repeat(40),
  cliPath: `/managed/runtime-candidates/${'b'.repeat(40)}/src/cli.js`,
  runtimeDir: `/managed/runtime-candidates/${'b'.repeat(40)}`,
};

function timer(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

test('remote branch head parser accepts only an exact 40-hex SHA', () => {
  const runner = () => ({ status: 0, stdout: `${'A'.repeat(40)}\trefs/heads/main\n` });
  assert.equal(
    remoteBranchHead('main', { paths: { gitHome: '/safe', hooks: '/hooks' }, runner }),
    'a'.repeat(40),
  );
});

test('supervisor action compatibility still prioritizes operator stop, then update, then crash restart', () => {
  assert.equal(decideSupervisorAction({ childExitCode: 1, updatePending: true, operatorStopPending: true }), 'stop');
  assert.equal(decideSupervisorAction({ childExitCode: 0, updatePending: true }), 'update');
  assert.equal(decideSupervisorAction({ childExitCode: 0, updatePending: false }), 'stop');
  assert.equal(decideSupervisorAction({ childExitCode: 1, updatePending: false }), 'restart');
});

test('supervisor validates an exact candidate before draining current daemon, then health-checks activation', async () => {
  const events = [];
  const records = [];
  let starts = 0;
  let current = null;

  const spawnImpl = (_executable, args) => {
    starts += 1;
    const child = new EventEmitter();
    child.pid = 100 + starts;
    current = child;
    events.push(`start:${args[0].includes('runtime-candidates') ? 'candidate' : 'current'}`);
    if (starts === 2) setTimeout(() => child.emit('exit', 0, null), 20);
    return child;
  };
  const runDevBridgeCliFn = (command, _paths, runtime) => {
    events.push(`${command}:${runtime.head}`);
    if (command === 'stop') setTimeout(() => current.emit('exit', 0, null), 0);
    return 0;
  };
  const runDevBridgeCliCapturedFn = (command, _paths, runtime) => {
    events.push(`${command}:${runtime.head}`);
    if (command === 'pause') return { status: 0, stdout: JSON.stringify({ activeLock: true, paused: true }) };
    if (command === 'resume') return { status: 0, stdout: JSON.stringify({ activeLock: true, resumed: true, paused: false }) };
    throw new Error(`unexpected captured command: ${command}`);
  };
  const candidatePrepareFn = async (_args, _paths, { desiredHead }) => {
    events.push(`validate:${desiredHead}`);
    return runtimeB;
  };

  const result = await superviseDaemon(
    { channel: 'testing', update: true },
    paths,
    runtimeA,
    {
      spawnImpl,
      updateIntervalMs: 5,
      restartBackoffMs: 1,
      healthWindowMs: 1,
      maxIterations: 2,
      stopExisting: false,
      reconcileExitedDaemonFn: async () => ({ reconciled: false, reason: 'fixture' }),
      remoteHeadFn: () => runtimeB.head,
      candidatePrepareFn,
      runDevBridgeCliFn,
      runDevBridgeCliCapturedFn,
      recordActivationFn: (_paths, record) => { records.push(record); },
      resolveChannelRefFn: () => runtimeA.ref,
      updateCheckDelayFn: timer,
      healthCheckDelayFn: timer,
      delayFn: timer,
    },
  );

  assert.equal(result, 0);
  assert.deepEqual(events.slice(0, 5), [
    'start:current',
    `pause:${runtimeA.head}`,
    `validate:${runtimeB.head}`,
    `stop:${runtimeA.head}`,
    'start:candidate',
  ]);
  assert.ok(events.indexOf(`pause:${runtimeA.head}`) < events.indexOf(`validate:${runtimeB.head}`));
  assert.ok(events.includes(`doctor:${runtimeB.head}`));
  assert.ok(events.indexOf(`pause:${runtimeB.head}`) < events.indexOf(`doctor:${runtimeB.head}`));
  assert.ok(events.indexOf(`doctor:${runtimeB.head}`) < events.indexOf(`resume:${runtimeB.head}`));
  assert.ok(records.some((record) => record.state === 'candidate-validated'));
  assert.ok(records.some((record) => record.state === 'drain-requested'));
  assert.ok(records.some((record) => record.state === 'activating'));
  assert.ok(records.some((record) => record.state === 'healthy' && record.current.head === runtimeB.head));
});

test('failed candidate validation never drains the healthy current daemon', async () => {
  const events = [];
  const records = [];
  const child = new EventEmitter();
  child.pid = 200;
  const resultPromise = superviseDaemon(
    { channel: 'testing', update: true },
    paths,
    runtimeA,
    {
      spawnImpl: () => {
        setTimeout(() => child.emit('exit', 0, null), 10);
        return child;
      },
      updateIntervalMs: 5,
      maxIterations: 1,
      stopExisting: false,
      reconcileExitedDaemonFn: async () => ({ reconciled: false, reason: 'fixture' }),
      remoteHeadFn: () => runtimeB.head,
      candidatePrepareFn: async () => { events.push('validate'); throw new Error('test failure'); },
      runDevBridgeCliFn: (command) => { events.push(command); return 0; },
      runDevBridgeCliCapturedFn: (command) => {
        events.push(command);
        if (command === 'pause') return { status: 0, stdout: JSON.stringify({ activeLock: true, paused: true }) };
        if (command === 'resume') return { status: 0, stdout: JSON.stringify({ activeLock: true, resumed: true, paused: false }) };
        throw new Error(`unexpected captured command: ${command}`);
      },
      recordActivationFn: (_paths, record) => { records.push(record); },
      resolveChannelRefFn: () => runtimeA.ref,
      updateCheckDelayFn: timer,
      delayFn: timer,
    },
  );
  const result = await resultPromise;
  assert.equal(result, 0);
  assert.deepEqual(events, ['pause', 'validate', 'resume']);
  assert.ok(records.some((record) => record.state === 'candidate-failed'));
  assert.equal(records.at(-1).current.head, runtimeA.head);
});

test('candidate daemon crash inside health window rolls back to last-known-good runtime', async () => {
  const starts = [];
  const records = [];
  let current;
  const spawnImpl = (_executable, args) => {
    const child = new EventEmitter();
    child.pid = 300 + starts.length;
    current = child;
    const candidate = args[0].includes('runtime-candidates');
    starts.push(candidate ? 'candidate' : 'current');
    if (candidate) setTimeout(() => child.emit('exit', 1, null), 0);
    else if (starts.length === 3) setTimeout(() => child.emit('exit', 0, null), 5);
    return child;
  };
  const runDevBridgeCliFn = (command) => {
    if (command === 'stop') setTimeout(() => current.emit('exit', 0, null), 0);
    return 0;
  };

  const result = await superviseDaemon(
    { channel: 'testing', update: true },
    paths,
    runtimeA,
    {
      spawnImpl,
      updateIntervalMs: 5,
      maxIterations: 3,
      stopExisting: false,
      reconcileExitedDaemonFn: async () => ({ reconciled: false, reason: 'fixture' }),
      remoteHeadFn: () => runtimeB.head,
      candidatePrepareFn: async () => runtimeB,
      runDevBridgeCliFn,
      runDevBridgeCliCapturedFn: (command) => {
        if (command === 'pause') return { status: 0, stdout: JSON.stringify({ activeLock: true, paused: true }) };
        if (command === 'resume') return { status: 0, stdout: JSON.stringify({ activeLock: true, resumed: true, paused: false }) };
        throw new Error(`unexpected captured command: ${command}`);
      },
      recordActivationFn: (_paths, record) => { records.push(record); },
      resolveChannelRefFn: () => runtimeA.ref,
      updateCheckDelayFn: timer,
      healthCheckDelayFn: timer,
      delayFn: timer,
    },
  );

  assert.equal(result, 0);
  assert.deepEqual(starts, ['current', 'candidate', 'current']);
  assert.ok(records.some((record) => record.state === 'rolled-back' && record.current.head === runtimeA.head));
});

test('candidate health doctor runs at a cooperative pause boundary and failure preserves rollback evidence', async () => {
  const events = [];
  const records = [];
  const starts = [];
  let current;
  const spawnImpl = (_executable, args) => {
    const child = new EventEmitter();
    child.pid = 350 + starts.length;
    current = child;
    const candidate = args[0].includes('runtime-candidates');
    starts.push(candidate ? 'candidate' : 'current');
    if (starts.length === 3) setTimeout(() => child.emit('exit', 0, null), 5);
    return child;
  };

  const result = await superviseDaemon(
    { channel: 'testing', update: true },
    paths,
    runtimeA,
    {
      spawnImpl,
      updateIntervalMs: 5,
      restartBackoffMs: 1,
      healthWindowMs: 1,
      maxIterations: 3,
      stopExisting: false,
      reconcileExitedDaemonFn: async () => ({ reconciled: false, reason: 'fixture' }),
      remoteHeadFn: () => runtimeB.head,
      candidatePrepareFn: async () => runtimeB,
      runDevBridgeCliFn: (command, _paths, runtime) => {
        events.push(`${command}:${runtime.head}`);
        if (command === 'stop') setTimeout(() => current.emit('exit', 0, null), 0);
        return command === 'doctor' ? 1 : 0;
      },
      runDevBridgeCliCapturedFn: (command, _paths, runtime) => {
        events.push(`${command}:${runtime.head}`);
        if (command === 'pause') return { status: 0, stdout: JSON.stringify({ activeLock: true, paused: true }) };
        if (command === 'stop') {
          setTimeout(() => current.emit('exit', 0, null), 0);
          return { status: 0, stdout: JSON.stringify({ activeLock: true, stopped: true }) };
        }
        throw new Error(`unexpected captured command: ${command}`);
      },
      recordActivationFn: (_paths, record) => { records.push(record); },
      resolveChannelRefFn: () => runtimeA.ref,
      updateCheckDelayFn: timer,
      healthCheckDelayFn: timer,
      delayFn: timer,
    },
  );

  assert.equal(result, 0);
  assert.deepEqual(starts, ['current', 'candidate', 'current']);
  assert.ok(events.indexOf(`pause:${runtimeB.head}`) < events.indexOf(`doctor:${runtimeB.head}`));
  assert.ok(events.indexOf(`doctor:${runtimeB.head}`) < events.indexOf(`stop:${runtimeB.head}`));
  assert.equal(events.includes(`resume:${runtimeB.head}`), false);
  const rolledBack = records.findLast((record) => record.state === 'rolled-back');
  assert.equal(rolledBack.current.head, runtimeA.head);
  assert.equal(rolledBack.failedCandidate.head, runtimeB.head);
  assert.match(rolledBack.error.message, /health doctor failed/u);
});

test('supervisor restarts an unexpected daemon crash without mutating runtime', async () => {
  let starts = 0;
  const reconciled = [];
  const spawnImpl = () => {
    starts += 1;
    const child = new EventEmitter();
    child.pid = 400 + starts;
    setTimeout(() => child.emit('exit', starts === 1 ? 1 : 0, null), 5);
    return child;
  };

  const result = await superviseDaemon(
    { channel: 'testing', update: false },
    paths,
    runtimeA,
    {
      spawnImpl,
      maxIterations: 2,
      stopExisting: false,
      reconcileExitedDaemonFn: async (_paths, observed) => { reconciled.push(observed.pid); return { reconciled: true }; },
      restartBackoffMs: 1,
      delayFn: timer,
    },
  );

  assert.equal(result, 0);
  assert.equal(starts, 2);
  assert.deepEqual(reconciled, [401, 402]);
});
