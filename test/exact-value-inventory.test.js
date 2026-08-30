import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundEffectActions } from '../src/runtime/bound-effect-actions.js';
import { createExactValueInventory } from '../src/runtime/exact-value-inventory.js';

function value(identity, marker) {
  return Object.freeze({
    identity,
    digest: marker.repeat(64),
    bytes: marker.charCodeAt(0),
    private: Object.freeze({ location: `hidden-${marker}` }),
  });
}

function item(identity, marker, overrides = {}) {
  return Object.freeze({
    identity,
    provenance: 'created',
    protections: [],
    references: [],
    after: [],
    value: value(`set-${identity}`, marker),
    ...overrides,
  });
}

function recordStore() {
  const values = new Map();
  return Object.freeze({
    values,
    async run(subject, operation) {
      return operation(Object.freeze({
        async load() { return structuredClone(values.get(subject)); },
        async save(value) {
          if (values.has(subject)) throw new Error('unexpected replacement');
          values.set(subject, structuredClone(value));
        },
      }));
    },
  });
}

function fixture({ complete = true, active = false, items = [item('one', 'a'), item('two', 'b')] } = {}) {
  const state = {
    source: { identity: 'owner', generation: `generation-${'c'.repeat(64)}`, complete, items },
    active,
    observations: new Map(items.map((entry) => [entry.value.identity, 'present'])),
    removed: [],
  };
  const records = recordStore();
  const actions = Object.freeze({
    async observe(descriptor) {
      return Object.freeze({
        identity: descriptor.identity,
        state: state.observations.get(descriptor.identity) ?? 'absent',
        retryable: false,
      });
    },
    async remove(descriptor) {
      state.removed.push(descriptor.identity);
      state.observations.set(descriptor.identity, 'absent');
      return Object.freeze({ identity: descriptor.identity, removed: true });
    },
  });
  const make = () => createExactValueInventory({
    identity: 'owner',
    scope: 'payload',
    coverage: ['application'],
    source: { async observe() { return structuredClone(state.source); } },
    activity: { async observe() { return { identity: 'owner', active: state.active }; } },
    records,
    actions,
  });
  return { state, records, actions, make };
}

function input(fragment, itemIdentity = 'one') {
  const selected = fragment.items.find((entry) => entry.identity === itemIdentity);
  return Object.freeze({
    protocol: 'test/removal-v1',
    mode: 'application',
    item: itemIdentity,
    planDigest: 'd'.repeat(64),
    effect: selected.effects[0],
  });
}

test('dynamic exact values project deterministically and private descriptors remain behind binding', async () => {
  const selected = fixture({ items: [item('two', 'b', { provenance: 'adopted' }), item('one', 'a')] });
  const inventory = selected.make();
  const fragment = await inventory.snapshot();
  assert.deepEqual(fragment.coverage, ['application']);
  assert.deepEqual(fragment.items.map((entry) => entry.identity), ['one', 'two']);
  assert.deepEqual(fragment.items.map((entry) => entry.provenance), ['created', 'adopted']);
  assert.doesNotMatch(JSON.stringify(fragment), /hidden-/u);

  const bridge = createBoundEffectActions({ catalog: inventory, actions: selected.actions });
  const request = input(fragment);
  const binding = await bridge.bind(request);
  assert.deepEqual(Object.keys(binding).sort(), ['bound', 'identity', 'item', 'mode', 'planDigest', 'protocol']);
  assert.doesNotMatch(JSON.stringify(binding), /hidden-/u);
  await bridge.remove(request);
  assert.deepEqual(selected.state.removed, ['set-one']);

  const restarted = selected.make();
  const after = await restarted.snapshot();
  assert.equal(after.generation, fragment.generation);
  assert.deepEqual(after.items, fragment.items);
  assert.equal((await bridge.observe(request)).state, 'absent');
});

test('incomplete and active sources create no observation-based binding authority', async () => {
  const incomplete = fixture({ complete: false });
  let observations = 0;
  incomplete.state.observations = { get() { observations += 1; return 'present'; } };
  const incompleteFragment = await incomplete.make().snapshot();
  assert.deepEqual(incompleteFragment.coverage, []);
  assert.equal(observations, 0);
  await assert.rejects(() => incomplete.make().bind(input(incompleteFragment)), /not currently available/u);
  assert.equal(incomplete.records.values.size, 0);

  const active = fixture({ active: true });
  const activeFragment = await active.make().snapshot();
  assert.equal(activeFragment.mutationActive, true);
  await assert.rejects(() => active.make().bind(input(activeFragment)), /not currently available/u);
  assert.equal(active.records.values.size, 0);
});

test('ambiguous actions are preserved and cannot become bound effects', async () => {
  const selected = fixture();
  selected.state.observations.set('set-one', 'ambiguous');
  const inventory = selected.make();
  const fragment = await inventory.snapshot();
  assert.deepEqual(fragment.items.find((entry) => entry.identity === 'one').protections, ['state-ambiguous']);
  await assert.rejects(() => inventory.bind(input(fragment)), /not currently available/u);
  assert.equal(selected.records.values.size, 0);
});

test('source drift before binding creates no durable descriptor', async () => {
  const selected = fixture();
  const inventory = selected.make();
  const fragment = await inventory.snapshot();
  selected.state.source = { ...selected.state.source, generation: `generation-${'e'.repeat(64)}` };
  await assert.rejects(() => inventory.bind(input(fragment)), /changed before acceptance/u);
  assert.equal(selected.records.values.size, 0);
});

test('duplicate, missing, and cyclic dependencies fail before projection', async () => {
  for (const items of [
    [item('one', 'a'), item('one', 'b')],
    [item('one', 'a', { after: ['missing'] })],
    [item('one', 'a', { after: ['two'] }), item('two', 'b', { after: ['one'] })],
  ]) {
    await assert.rejects(() => fixture({ items }).make().snapshot(), /duplicate|dependency/u);
  }
});
