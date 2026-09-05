import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  dispatchProtectedOperation,
  PROTECTED_OPERATION_DISPATCH_PROTOCOL,
} from '../src/setup/protected-operation-dispatcher.js';

async function* chunks(...values) {
  for (const value of values) yield value;
}

test('neutral dispatcher accepts one bounded JSON frame and performs exactly once', async () => {
  let calls = 0;
  let selected = null;
  const result = await dispatchProtectedOperation({ input: chunks('{"action":', '"refresh"}') }, {
    perform: async (subject) => {
      calls += 1;
      selected = subject;
      return Object.freeze({ ready: true, values: Object.freeze([1, 'two']) });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(selected, { action: 'refresh' });
  assert.deepEqual(result, {
    protocol: PROTECTED_OPERATION_DISPATCH_PROTOCOL,
    completed: true,
    output: '{"ready":true,"values":[1,"two"]}',
    reason: null,
  });
  assert.equal(Object.isFrozen(result), true);
});

test('neutral dispatcher rejects malformed or oversized input without performing', async () => {
  for (const input of [
    '',
    '[]',
    '{',
    new Uint8Array([0xc3, 0x28]),
    'x'.repeat((32 * 1024) + 1),
    1,
  ]) {
    let calls = 0;
    const result = await dispatchProtectedOperation({ input }, { perform: async () => { calls += 1; return {}; } });
    assert.equal(result.completed, false);
    assert.equal(result.reason, 'input-invalid');
    assert.equal(calls, 0);
  }
});

test('neutral dispatcher normalizes operation and output failures', async () => {
  const failed = await dispatchProtectedOperation({ input: '{}' }, {
    perform: async () => { throw new Error('/private/path'); },
  });
  assert.equal(failed.completed, false);
  assert.equal(failed.reason, 'operation-failed');
  assert.equal(JSON.stringify(failed).includes('/private'), false);

  const cyclic = {};
  cyclic.self = cyclic;
  const hiddenArray = [];
  Object.defineProperty(hiddenArray, 'hidden', { value: true });
  const cases = [
    null,
    [],
    new Date(),
    { nested: { toJSON() { return 'forged'; } } },
    { value: 1n },
    { value: Number.NaN },
    cyclic,
    { value: hiddenArray },
    { ['x'.repeat(1_025)]: true },
    { value: 'x'.repeat(33 * 1024) },
  ];
  for (const output of cases) {
    const result = await dispatchProtectedOperation({ input: '{}' }, { perform: async () => output });
    assert.equal(result.completed, false);
    assert.equal(result.reason, 'output-invalid');
  }
});

test('neutral dispatcher has an exact two-port topology', async () => {
  await assert.rejects(
    dispatchProtectedOperation({ input: '{}', executable: '/bin/foreign' }, { perform: async () => ({}) }),
    /unknown field/u,
  );
  await assert.rejects(
    dispatchProtectedOperation({ input: '{}' }, { perform: async () => ({}), fallback: async () => ({}) }),
    /unknown field/u,
  );
});

test('neutral dispatcher source is import-free and topology-agnostic', async () => {
  const source = (await readFile(new URL('../src/setup/protected-operation-dispatcher.js', import.meta.url), 'utf8')).toLowerCase();
  assert.equal(/^import\s/mu.test(source), false);
  for (const identity of ['linux', 'windows', 'sudo', 'pkexec', 'setup', 'service', 'provider', 'repository', 'virtual-machine', 'child_process']) {
    assert.equal(source.includes(identity), false, identity);
  }
});
