import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundEffectActions } from '../src/runtime/bound-effect-actions.js';

const input = Object.freeze({
  protocol: 'devbridge/local-v1',
  mode: 'application',
  item: 'item-one',
  planDigest: 'a'.repeat(64),
  effect: Object.freeze({ identity: 'effect-one', bytes: 4, terminal: true }),
});

function bound(changes = {}) {
  return {
    protocol: input.protocol,
    mode: input.mode,
    item: input.item,
    identity: input.effect.identity,
    planDigest: input.planDigest,
    bound: true,
    value: { identity: 'private-value', location: 'private-location' },
    ...changes,
  };
}

test('bound action bridge hides private values and reloads them for observation and removal', async () => {
  const calls = [];
  const bridge = createBoundEffectActions({
    catalog: {
      async bind(selected) { calls.push(['bind', selected]); return bound(); },
      async load(selected) { calls.push(['load', selected]); return bound(); },
      async retire(selected) { calls.push(['retire', selected]); return { identity: selected.effect.identity, retired: true }; },
    },
    actions: {
      async observe(value) { calls.push(['observe', value]); return { identity: value.identity, state: 'present', retryable: true }; },
      async remove(value) { calls.push(['remove', value]); return { removed: true }; },
    },
  });
  const published = await bridge.bind(input);
  assert.deepEqual(Object.keys(published), ['protocol', 'mode', 'item', 'identity', 'planDigest', 'bound']);
  assert.equal(JSON.stringify(published).includes('private'), false);
  assert.deepEqual(await bridge.observe(input), { identity: 'effect-one', state: 'present', retryable: true });
  assert.deepEqual(await bridge.remove(input), { removed: true });
  assert.deepEqual(await bridge.retire(input), { identity: 'effect-one', retired: true });
  assert.equal(calls.filter(([name]) => name === 'load').length, 2);
  assert.deepEqual(calls.find(([name]) => name === 'observe')[1], bound().value);
});

test('binding substitution, malformed observation, and non-JSON private data fail closed', async () => {
  const actions = { async observe() { return { identity: 'value', state: 'present', retryable: true }; }, async remove() {} };
  const substituted = createBoundEffectActions({
    catalog: {
      async bind() { return bound({ identity: 'effect-other' }); },
      async load() { return bound(); },
      async retire() { return { identity: 'effect-one', retired: true }; },
    },
    actions,
  });
  await assert.rejects(() => substituted.bind(input), /exact input/u);

  const malformed = createBoundEffectActions({
    catalog: {
      async bind() { return bound(); },
      async load() { return bound(); },
      async retire() { return { identity: 'effect-one', retired: true }; },
    },
    actions: { ...actions, async observe() { return { identity: 'value', state: 'unknown', retryable: false }; } },
  });
  await assert.rejects(() => malformed.observe(input), /observation is invalid/u);

  const privateFunction = createBoundEffectActions({
    catalog: {
      async bind() { return bound({ value: { method() {} } }); },
      async load() { return bound(); },
      async retire() { return { identity: 'effect-one', retired: true }; },
    },
    actions,
  });
  await assert.rejects(() => privateFunction.bind(input), /exact JSON/u);

  const privateUndefined = createBoundEffectActions({
    catalog: {
      async bind() { return bound({ value: { nested: undefined } }); },
      async load() { return bound(); },
      async retire() { return { identity: 'effect-one', retired: true }; },
    },
    actions,
  });
  await assert.rejects(() => privateUndefined.bind(input), /exact JSON/u);
});
