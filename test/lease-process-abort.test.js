import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import process from 'node:process';
import { TaskLeaseLostError } from '../src/errors.js';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';

test('deterministic child execution is terminated when the task lease abort signal fires', async () => {
  const runner = new DeterministicProcessRunner();
  const controller = new AbortController();
  const fence = new TaskLeaseLostError('lease CAS lost');
  const pending = runner.run({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: os.tmpdir(),
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    operation: 'test.lease-abort',
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(fence), 100);
  timer.unref?.();
  const result = await pending.finally(() => clearTimeout(timer));
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(controller.signal.reason, fence);
});

test('already-fenced deterministic execution never spawns a child', async () => {
  const runner = new DeterministicProcessRunner();
  const controller = new AbortController();
  const fence = new TaskLeaseLostError('lease expired');
  controller.abort(fence);
  await assert.rejects(
    runner.run({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      operation: 'test.lease-preabort',
      signal: controller.signal,
    }),
    (error) => error === fence,
  );
});
