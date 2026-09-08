import test from 'node:test';
import assert from 'node:assert/strict';
import { bindInvocationToLease } from '../src/runtime/lease-bound-invocation.js';

test('lease loss cancels submitted native work and prevents another submission', async () => {
  const loss = new AbortController();
  let calls = 0;
  const invoke = bindInvocationToLease(async (request) => {
    calls++;
    assert.equal(request.signal.aborted, false);
    loss.abort(new Error('holder died'));
    assert.equal(request.signal.aborted, true);
    return { exitCode: 0 };
  }, { signal: loss.signal, assertHeld: () => loss.signal.throwIfAborted() });
  await assert.rejects(invoke({ executable: 'native-provider' }), /holder died/u);
  await assert.rejects(invoke({ executable: 'native-provider' }), /holder died/u);
  assert.equal(calls, 1);
});

test('caller cancellation remains linked without affecting lease ownership', async () => {
  const lease = new AbortController();
  const caller = new AbortController();
  const invoke = bindInvocationToLease(async ({ signal, timeoutMs }) => {
    assert.equal(timeoutMs, 500);
    caller.abort();
    assert.equal(signal.aborted, true);
    assert.equal(lease.signal.aborted, false);
    return { aborted: true };
  }, { signal: lease.signal, assertHeld: () => lease.signal.throwIfAborted() });
  assert.deepEqual(await invoke({ signal: caller.signal, timeoutMs: 500 }), { aborted: true });
});
