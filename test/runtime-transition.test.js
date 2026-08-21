import test from 'node:test';
import assert from 'node:assert/strict';
import { pauseRuntimeOwner, resumeRuntimeOwner } from '../src/bootstrap/runtime-transition.mjs';

const owner = { activeLock: true, pid: 41, createdAt: '2026-08-21T00:00:00.000Z', pauseRequested: false, paused: false };
function result(status, value) { return { status, stdout: `${JSON.stringify(value)}\n`, stderr: '' }; }

test('candidate transition waits for exact safe-boundary acknowledgement of one runtime generation', async () => {
  const calls = [];
  let pauseAttempts = 0;
  const control = async (command) => {
    calls.push(command);
    if (command === 'status') return result(0, owner);
    pauseAttempts += 1;
    if (pauseAttempts === 1) return result(3, { ...owner, pauseRequested: true, paused: false });
    return result(0, { ...owner, pauseRequested: true, paused: true });
  };
  assert.deepEqual(await pauseRuntimeOwner(control), { pid: owner.pid, createdAt: owner.createdAt });
  assert.deepEqual(calls, ['status', 'pause', 'pause']);
});

test('stale acknowledgement or PID reuse cannot satisfy an expected runtime generation', async () => {
  const replacement = { ...owner, createdAt: '2026-08-21T00:00:01.000Z', paused: true, pauseRequested: true };
  let calls = 0;
  const control = async (command) => {
    calls += 1;
    return command === 'status' ? result(0, owner) : result(0, replacement);
  };
  await assert.rejects(pauseRuntimeOwner(control), /generation changed/u);
  assert.equal(calls, 2);
});

test('candidate rejection resumes only the exact accepted runtime generation', async () => {
  const expected = { pid: owner.pid, createdAt: owner.createdAt };
  const calls = [];
  const control = async (command) => {
    calls.push(command);
    if (command === 'resume') return result(0, { activeLock: true, pid: owner.pid, resumed: true, pauseRequested: false, paused: false });
    return result(0, owner);
  };
  assert.deepEqual(await resumeRuntimeOwner(control, expected), { ...expected, resumed: true });
  assert.deepEqual(calls, ['resume', 'status']);
});
