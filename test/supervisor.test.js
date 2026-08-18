import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  decideSupervisorAction,
  remoteBranchHead,
  superviseDaemon,
} from '../patch-poller.mjs';

const paths = { runtime: '/managed/runtime', config: '/operator/config.json' };
const runtimeA = {
  head: 'a'.repeat(40),
  ref: 'sol/foundation-bootstrap',
  cliPath: '/managed/runtime/src/cli.js',
  version: '0.1.0',
};
const runtimeB = {
  ...runtimeA,
  head: 'b'.repeat(40),
};

test('remote branch head parser accepts only an exact 40-hex SHA', () => {
  const runner = () => ({ status: 0, stdout: `${'A'.repeat(40)}\trefs/heads/main\n` });
  assert.equal(
    remoteBranchHead('main', { paths: { gitHome: '/safe', hooks: '/hooks' }, runner }),
    'a'.repeat(40),
  );
});

test('supervisor action prioritizes operator stop, then update, then crash restart', () => {
  assert.equal(decideSupervisorAction({ childExitCode: 1, updatePending: true, operatorStopPending: true }), 'stop');
  assert.equal(decideSupervisorAction({ childExitCode: 0, updatePending: true }), 'update');
  assert.equal(decideSupervisorAction({ childExitCode: 0, updatePending: false }), 'stop');
  assert.equal(decideSupervisorAction({ childExitCode: 1, updatePending: false }), 'restart');
});

test('supervisor drains the current daemon before updating and relaunching the new runtime', async () => {
  let starts = 0;
  let current = null;
  let stopCalls = 0;
  let updates = 0;
  let doctors = 0;

  const spawnImpl = () => {
    starts += 1;
    const child = new EventEmitter();
    child.pid = 100 + starts;
    current = child;
    if (starts === 2) setTimeout(() => child.emit('exit', 0, null), 20);
    return child;
  };
  const runPollerCliFn = (command) => {
    if (command === 'stop') {
      stopCalls += 1;
      setTimeout(() => current.emit('exit', 0, null), 0);
      return 0;
    }
    if (command === 'doctor') {
      doctors += 1;
      return 0;
    }
    return 0;
  };

  const result = await superviseDaemon(
    { channel: 'testing', update: true },
    paths,
    runtimeA,
    {
      spawnImpl,
      updateIntervalMs: 5,
      restartBackoffMs: 1,
      maxIterations: 2,
      takeover: false,
      remoteHeadFn: () => runtimeB.head,
      ensureRuntimeFn: () => { updates += 1; return runtimeB; },
      runPollerCliFn,
      resolveChannelRefFn: () => runtimeA.ref,
      updateCheckDelayFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      delayFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  );

  assert.equal(result, 0);
  assert.equal(starts, 2);
  assert.equal(stopCalls, 1);
  assert.equal(updates, 1);
  assert.equal(doctors, 1);
});

test('supervisor restarts an unexpected daemon crash without mutating runtime', async () => {
  let starts = 0;
  const spawnImpl = () => {
    starts += 1;
    const child = new EventEmitter();
    child.pid = 200 + starts;
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
      takeover: false,
      restartBackoffMs: 1,
      delayFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  );

  assert.equal(result, 0);
  assert.equal(starts, 2);
});
