import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_LIVENESS_PROTOCOL, createLocalLiveness, runWithLocalLiveness } from '../src/app/local-liveness.js';

function fixture(write = () => true) {
  let clock = 1_000;
  const callbacks = [];
  const cancelled = [];
  let unrefCount = 0;
  const output = { write };
  const options = {
    output,
    intervalMs: 10,
    now: () => clock,
    schedule(callback, interval) {
      const timer = { interval, unref() { unrefCount += 1; } };
      callbacks.push({ callback, timer });
      return timer;
    },
    cancel(timer) { cancelled.push(timer); },
  };
  return {
    options,
    callbacks,
    cancelled,
    advance(milliseconds) { clock += milliseconds; callbacks[0]?.callback(); },
    get unrefCount() { return unrefCount; },
  };
}

function record(line) {
  assert.match(line, /^\[devbridge-liveness\] /u);
  return JSON.parse(line.slice('[devbridge-liveness] '.length));
}

test('local liveness projects only bounded neutral fields and clears one unrefed timer', async () => {
  const lines = [];
  const state = fixture((line) => { lines.push(line); return true; });
  const result = await runWithLocalLiveness(async (update) => {
    update({ phase: 'attempted', completed: 1, total: 3, attempt: 2, path: 'must-not-cross', identity: 'foreign' });
    state.advance(25);
    return { accepted: true };
  }, state.options);

  assert.deepEqual(result, { accepted: true });
  assert.equal(state.unrefCount, 1);
  assert.equal(state.cancelled.length, 1);
  assert.deepEqual(record(lines[0]), {
    protocol: LOCAL_LIVENESS_PROTOCOL,
    phase: 'starting',
    elapsedMs: 0,
    completed: 0,
    total: null,
    attempt: 0,
  });
  assert.deepEqual(record(lines[1]), {
    protocol: LOCAL_LIVENESS_PROTOCOL,
    phase: 'attempted',
    elapsedMs: 25,
    completed: 1,
    total: 3,
    attempt: 2,
  });
  assert.doesNotMatch(lines.join(''), /must-not-cross|foreign|path|identity/u);
  state.advance(25);
  assert.equal(lines.length, 2, 'stopped liveness must not emit after operation completion');
});

test('no-progress work repeats bounded elapsed liveness without inventing progress', () => {
  const lines = [];
  const state = fixture((line) => { lines.push(line); return true; });
  const liveness = createLocalLiveness(state.options);
  liveness.start();
  state.advance(10);
  state.advance(15);
  liveness.stop();
  assert.deepEqual(lines.map((line) => record(line).elapsedMs), [0, 10, 25]);
  assert.deepEqual(lines.map((line) => record(line).phase), ['starting', 'starting', 'starting']);
  assert.ok(lines.every((line) => Buffer.byteLength(line) < 256));
});

test('backpressure and output failure suppress further writes without operation authority', async () => {
  let writes = 0;
  const backpressured = fixture(() => { writes += 1; return false; });
  const accepted = await runWithLocalLiveness(async (update) => {
    update({ phase: 'planning' });
    backpressured.advance(10);
    backpressured.advance(10);
    return 'accepted';
  }, backpressured.options);
  assert.equal(accepted, 'accepted');
  assert.equal(writes, 1);

  const failed = fixture(() => { throw new Error('output unavailable'); });
  const preserved = await runWithLocalLiveness(async () => 'preserved', failed.options);
  assert.equal(preserved, 'preserved');
  assert.equal(failed.cancelled.length, 1);
});

test('operation failure remains exact and always stops liveness', async () => {
  const lines = [];
  const state = fixture((line) => { lines.push(line); return true; });
  const failure = new Error('operation failed');
  await assert.rejects(
    () => runWithLocalLiveness(async (update) => {
      update({ phase: 'planning' });
      state.advance(10);
      throw failure;
    }, state.options),
    (error) => error === failure,
  );
  assert.equal(state.cancelled.length, 1);
  state.advance(10);
  assert.equal(lines.length, 2);
});

test('malformed progress is ignored and cannot alter the operation', async () => {
  const lines = [];
  const state = fixture((line) => { lines.push(line); return true; });
  const result = await runWithLocalLiveness(async (update) => {
    update({ phase: '../escape', completed: -1, total: 0 });
    state.advance(10);
    return 7;
  }, state.options);
  assert.equal(result, 7);
  assert.equal(record(lines[1]).phase, 'starting');
});
