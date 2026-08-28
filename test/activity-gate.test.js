import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createActivityGate } from '../src/runtime/activity-gate.js';

const SHARED = Object.freeze({ subject: 'subject-shared', operationId: 'operation-shared' });
const EXCLUSIVE = Object.freeze({ subject: 'subject-exclusive', operationId: 'operation-exclusive' });

function intentPort(state, name, calls) {
  return {
    async observe() { calls.push(['observe', name]); return state[name]; },
    async ensure(value) {
      calls.push(['ensure', name, value]);
      if (state[name] != null && (state[name].subject !== value.subject || state[name].operationId !== value.operationId)) {
        throw new Error(`foreign ${name} intent`);
      }
      state[name] = Object.freeze({ ...value });
      return state[name];
    },
    async clear(value) {
      calls.push(['clear', name, value]);
      if (state[name] == null || state[name].subject !== value.subject || state[name].operationId !== value.operationId) return false;
      state[name] = null;
      return true;
    },
  };
}

function fixture({ shared = null, exclusive = null } = {}) {
  const state = { shared, exclusive, sharedHolders: 0, exclusiveHeld: false };
  const calls = [];
  const ports = {
    sharedIntent: intentPort(state, 'shared', calls),
    exclusiveIntent: intentPort(state, 'exclusive', calls),
    lease: {
      async acquire({ mode }) {
        calls.push(['acquire', mode]);
        if (mode === 'shared') {
          if (state.exclusiveHeld) return null;
          state.sharedHolders += 1;
          let released = false;
          return {
            async release() {
              calls.push(['release', mode]);
              if (!released) state.sharedHolders -= 1;
              released = true;
            },
          };
        }
        if (state.exclusiveHeld || state.sharedHolders > 0) return null;
        state.exclusiveHeld = true;
        let released = false;
        return {
          async release() {
            calls.push(['release', mode]);
            if (!released) state.exclusiveHeld = false;
            released = true;
          },
        };
      },
    },
  };
  return { state, calls, ports, gate: createActivityGate(ports) };
}

test('shared admission publishes locally and double-observes around its lease', async () => {
  const values = fixture();
  const held = await values.gate.shared.acquire(SHARED);
  assert.equal(values.state.sharedHolders, 1);
  assert.deepEqual(values.state.shared, SHARED);
  assert.deepEqual(values.calls, [
    ['observe', 'exclusive'],
    ['ensure', 'shared', SHARED],
    ['acquire', 'shared'],
    ['observe', 'shared'],
    ['observe', 'exclusive'],
  ]);
  await held.release();
  assert.equal(values.state.sharedHolders, 0);
  assert.equal(values.state.shared, null);
  assert.deepEqual(values.calls.slice(-2).map(([name]) => name), ['clear', 'release']);
});

test('exclusive intent blocks shared admission before local publication', async () => {
  const values = fixture({ exclusive: EXCLUSIVE });
  assert.equal(await values.gate.shared.acquire(SHARED), null);
  assert.deepEqual(values.calls, [['observe', 'exclusive']]);
  assert.equal(values.state.shared, null);
});

test('exclusive intent appearing after shared publication releases and clears in order', async () => {
  const values = fixture();
  let observations = 0;
  values.ports.exclusiveIntent.observe = async () => {
    values.calls.push(['observe', 'exclusive']);
    observations += 1;
    return observations === 1 ? null : EXCLUSIVE;
  };
  values.gate = createActivityGate(values.ports);
  assert.equal(await values.gate.shared.acquire(SHARED), null);
  assert.equal(values.state.sharedHolders, 0);
  assert.equal(values.state.shared, null);
  assert.deepEqual(values.calls.slice(-2).map(([name]) => name), ['release', 'clear']);
});

test('shared lease refusal clears unpublished activity while release failure retains it', async () => {
  const values = fixture();
  values.ports.lease.acquire = async () => null;
  values.gate = createActivityGate(values.ports);
  assert.equal(await values.gate.shared.acquire(SHARED), null);
  assert.equal(values.state.shared, null);

  const failed = fixture();
  failed.ports.exclusiveIntent.observe = async () => failed.state.exclusive ?? null;
  let seen = 0;
  failed.ports.exclusiveIntent.observe = async () => (++seen === 1 ? null : EXCLUSIVE);
  failed.ports.lease.acquire = async () => ({ async release() { throw new Error('release failed'); } });
  failed.gate = createActivityGate(failed.ports);
  await assert.rejects(() => failed.gate.shared.acquire(SHARED), /release failed/u);
  assert.deepEqual(failed.state.shared, SHARED);
});

test('exclusive admission publishes first and refuses stale shared activity after acquiring', async () => {
  const values = fixture({ shared: SHARED });
  await assert.rejects(() => values.gate.exclusive.acquire(EXCLUSIVE), /shared activity remains/u);
  assert.equal(values.state.exclusiveHeld, false);
  assert.deepEqual(values.state.exclusive, EXCLUSIVE);
  assert.deepEqual(values.state.shared, SHARED);
  assert.equal(values.calls.some(([name]) => name === 'clear'), false);
});

test('exclusive completion clears exact intent before releasing its lease', async () => {
  const values = fixture();
  const held = await values.gate.exclusive.acquire(EXCLUSIVE);
  assert.equal(values.state.exclusiveHeld, true);
  assert.deepEqual(values.state.exclusive, EXCLUSIVE);
  await held.release();
  assert.equal(values.state.exclusiveHeld, false);
  assert.equal(values.state.exclusive, null);
  assert.deepEqual(values.calls.slice(-2).map(([name]) => name), ['clear', 'release']);
});

test('holder loss during active work preserves intent and release failure occurs after exact clearing', async () => {
  for (const [side, request] of [['shared', SHARED], ['exclusive', EXCLUSIVE]]) {
    const values = fixture();
    values.ports.lease.acquire = async () => ({ async release() { throw new Error('release failed'); } });
    values.gate = createActivityGate(values.ports);
    const held = await values.gate[side].acquire(request);
    assert.deepEqual(values.state[side], request, 'unreleased active holder retains its intent');
    await assert.rejects(() => held.release(), /release failed/u);
    assert.equal(values.state[side], null, 'release begins only after work and clears while still serialized');
  }
});

test('intent clear failure retains the kernel lease and can be retried exactly', async () => {
  const values = fixture();
  let clears = 0;
  values.ports.sharedIntent.clear = async (value) => {
    clears += 1;
    if (clears === 1) throw new Error('clear failed');
    return intentPort(values.state, 'shared', values.calls).clear(value);
  };
  values.gate = createActivityGate(values.ports);
  const held = await values.gate.shared.acquire(SHARED);
  await assert.rejects(() => held.release(), /clear failed/u);
  assert.equal(values.state.sharedHolders, 1);
  assert.deepEqual(values.state.shared, SHARED);
  await held.release();
  assert.equal(values.state.sharedHolders, 0);
  assert.equal(values.state.shared, null);
});

test('shared stale intent reconciliation is exact and independently invocable', async () => {
  const values = fixture({ shared: SHARED });
  assert.equal(await values.gate.shared.reconcile(), true);
  assert.equal(values.state.shared, null);
  assert.equal(await values.gate.shared.reconcile(), false);
  assert.deepEqual(values.calls.map(([name]) => name), ['observe', 'clear', 'observe', 'observe']);
});

test('widened requests, records, and leases fail closed', async () => {
  const values = fixture();
  await assert.rejects(() => values.gate.shared.acquire({ ...SHARED, source: 'foreign' }), /unknown field/u);
  values.ports.exclusiveIntent.observe = async () => ({ ...EXCLUSIVE, extra: true });
  values.gate = createActivityGate(values.ports);
  await assert.rejects(() => values.gate.shared.acquire(SHARED), /unknown field/u);
  const widened = fixture();
  widened.ports.lease.acquire = async () => ({ release: async () => {}, path: '/foreign' });
  widened.gate = createActivityGate(widened.ports);
  await assert.rejects(() => widened.gate.shared.acquire(SHARED), /unknown field/u);
});

test('shared mechanic source remains isolated from topology and participant identities', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/runtime/activity-gate.js', import.meta.url)), 'utf8');
  for (const forbidden of ['daemon', 'lifecycle', 'linux', 'systemd', 'flock', 'repository', 'provider', 'virtualMachine', 'stateDirectory', 'runDirectory']) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, `activity gate leaked ${forbidden}`);
  }
});
