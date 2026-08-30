import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPLICATION_REMOVAL_PROTOCOL,
  createApplicationRemoval,
} from '../src/app/application-removal.js';

function effect(identity, bytes = 1, terminal = false) {
  return { identity, bytes, terminal };
}

function item(identity, changes = {}) {
  return {
    identity,
    scope: 'payload',
    provenance: 'created',
    protections: [],
    references: [],
    after: [],
    effects: [effect(`effect-${identity}-data`, 10), effect(`effect-${identity}-receipt`, 0, true)],
    ...changes,
  };
}

function snapshot(changes = {}) {
  return {
    protocol: APPLICATION_REMOVAL_PROTOCOL,
    generation: 'generation-one',
    coverage: ['application', 'purge'],
    mutationActive: false,
    protectedReferences: ['reference-active'],
    items: [
      item('item-core'),
      item('item-entry', { after: ['item-core'] }),
      item('item-authority', { scope: 'authority' }),
      item('item-managed', { scope: 'managed', references: ['reference-active'] }),
      item('item-retained', { protections: ['required'] }),
      item('item-foreign', { provenance: 'foreign', effects: [] }),
    ],
    ...changes,
  };
}

function harness(initial = snapshot(), { removeEffect = null, observeEffect = null, bindEffect = null, retireEffect = null } = {}) {
  let current = structuredClone(initial);
  const records = new Map();
  const present = new Set(current.items.flatMap((entry) => entry.effects.map((selected) => selected.identity)));
  const removals = [];
  const bindings = [];
  const retirements = [];
  const saves = [];
  const api = createApplicationRemoval({
    source: {
      async snapshot() { return structuredClone(current); },
      async run(_mode, operation) { return operation(); },
    },
    journal: {
      async run(mode, operation) {
        return operation({
          async load() { return structuredClone(records.get(mode)); },
          async save(value) {
            records.set(mode, structuredClone(value));
            saves.push(structuredClone(value));
          },
        });
      },
    },
    effects: {
      async bind(input) {
        bindings.push(structuredClone(input));
        if (bindEffect) return bindEffect(input);
        return {
          protocol: APPLICATION_REMOVAL_PROTOCOL,
          mode: input.mode,
          item: input.item,
          identity: input.effect.identity,
          planDigest: input.planDigest,
          bound: true,
        };
      },
      async observe(input) {
        if (observeEffect) return observeEffect(input, present);
        return { identity: input.effect.identity, state: present.has(input.effect.identity) ? 'present' : 'absent', retryable: true };
      },
      async remove(input) {
        removals.push(structuredClone(input));
        if (removeEffect) return removeEffect(input, present);
        present.delete(input.effect.identity);
        return undefined;
      },
      async retire(input) {
        retirements.push(structuredClone(input));
        if (retireEffect) return retireEffect(input, present);
        return { identity: input.effect.identity, retired: true };
      },
    },
  });
  return {
    api,
    records,
    present,
    removals,
    bindings,
    retirements,
    saves,
    setSnapshot(value) { current = structuredClone(value); },
  };
}

function preserved(plan, identity) {
  return plan.preserved.find((entry) => entry.identity === identity);
}

test('plans are deterministic, bounded, mode-specific, and effect-opaque', async () => {
  const first = harness();
  const second = harness({ ...snapshot(), items: [...snapshot().items].reverse() });
  const application = await first.api.inspect({ mode: 'application' });
  const reordered = await second.api.inspect({ mode: 'application' });
  const purge = await first.api.inspect({ mode: 'purge' });

  assert.equal(application.protocol, APPLICATION_REMOVAL_PROTOCOL);
  assert.equal(application.digest, reordered.digest);
  assert.equal(application.complete, true);
  assert.equal(application.ready, true);
  assert.deepEqual(application.selected.map((entry) => entry.identity), ['item-core', 'item-entry']);
  assert.deepEqual(purge.selected.map((entry) => entry.identity), ['item-authority', 'item-core', 'item-entry']);
  assert.deepEqual(preserved(application, 'item-authority').reasons, ['outside-mode']);
  assert.deepEqual(preserved(application, 'item-managed').reasons, ['outside-mode', 'referenced']);
  assert.deepEqual(preserved(application, 'item-retained').reasons, ['protected']);
  assert.deepEqual(preserved(application, 'item-foreign').reasons, ['foreign']);
  assert.equal(JSON.stringify(application).includes('effect-'), false);
  assert.equal(JSON.stringify(application).includes('reference-active'), false);
});

test('terminal retirement starts only after every selected effect is reconciled absent', async () => {
  const selected = snapshot({ items: [item('item-core'), item('item-entry', { after: ['item-core'] })] });
  const state = harness(selected, {
    retireEffect(input, present) {
      assert.equal(present.size, 0);
      return { identity: input.effect.identity, retired: true };
    },
  });
  const plan = await state.api.inspect({ mode: 'application' });
  const result = await state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
  assert.equal(result.complete, true);
  assert.deepEqual(state.retirements.map((entry) => entry.effect.identity), [
    'effect-item-entry-receipt',
    'effect-item-core-receipt',
  ]);
});

test('interrupted terminal retirement resumes without replaying payload deletion', async () => {
  const selected = snapshot({ items: [item('item-core')] });
  let interrupt = true;
  const state = harness(selected, {
    retireEffect(input) {
      if (interrupt) throw new Error('simulated retirement interruption');
      return { identity: input.effect.identity, retired: true };
    },
  });
  const plan = await state.api.inspect({ mode: 'application' });
  await assert.rejects(
    () => state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' }),
    /retirement interruption/u,
  );
  assert.equal(state.records.get('application').phase, 'retirement-attempted');
  const removalCount = state.removals.length;
  interrupt = false;
  const result = await state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
  assert.equal(result.complete, true);
  assert.equal(state.removals.length, removalCount);
  assert.equal(state.retirements.length, 2);
});

test('a completed operation rotates only for a newly confirmed exact plan', async () => {
  const firstSnapshot = snapshot({ generation: 'generation-first', items: [item('item-core')] });
  const state = harness(firstSnapshot);
  const first = await state.api.inspect({ mode: 'application' });
  await state.api.remove({ mode: 'application', planDigest: first.digest, confirmation: 'REMOVE' });
  const firstRevision = state.records.get('application').revision;

  const nextSnapshot = snapshot({ generation: 'generation-second', items: [item('item-core')] });
  state.setSnapshot(nextSnapshot);
  for (const selected of nextSnapshot.items[0].effects) state.present.add(selected.identity);
  const next = await state.api.inspect({ mode: 'application' });
  assert.notEqual(next.digest, first.digest);
  const repeated = await state.api.remove({ mode: 'application', planDigest: first.digest, confirmation: 'REMOVE' });
  assert.equal(repeated.planDigest, first.digest);
  assert.equal(state.records.get('application').revision, firstRevision);
  const result = await state.api.remove({ mode: 'application', planDigest: next.digest, confirmation: 'REMOVE' });
  assert.equal(result.complete, true);
  assert.ok(state.records.get('application').revision > firstRevision);
  assert.equal(state.records.get('application').planDigest, next.digest);
});

test('a journal receipt for another mode cannot satisfy the requested operation', async () => {
  const state = harness();
  const application = await state.api.inspect({ mode: 'application' });
  await state.api.remove({ mode: 'application', planDigest: application.digest, confirmation: 'REMOVE' });
  const substituted = structuredClone(state.records.get('application'));
  state.records.set('purge', substituted);

  await assert.rejects(
    () => state.api.remove({ mode: 'purge', planDigest: application.digest, confirmation: 'REMOVE' }),
    /journal mode/u,
  );
});

test('exact REMOVE plus current digest crosses selected effects in dependency order', async () => {
  const state = harness();
  const plan = await state.api.inspect({ mode: 'application' });
  await assert.rejects(
    () => state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'remove' }),
    /exact literal REMOVE/u,
  );
  await assert.rejects(
    () => state.api.remove({ mode: 'application', planDigest: '0'.repeat(64), confirmation: 'REMOVE' }),
    /current plan/u,
  );

  const result = await state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
  assert.equal(result.complete, true);
  assert.equal(result.effectCount, 4);
  assert.deepEqual(result.removed, ['item-core', 'item-entry']);
  assert.deepEqual(result.absent, []);
  assert.deepEqual(result.preserved.map((entry) => entry.identity), ['item-authority', 'item-foreign', 'item-managed', 'item-retained']);
  assert.deepEqual(
    state.removals.map((entry) => entry.effect.identity),
    ['effect-item-core-data', 'effect-item-core-receipt', 'effect-item-entry-data', 'effect-item-entry-receipt'],
  );
  assert.equal(state.saves.at(0).phase, 'planned');
  assert.equal(state.saves.at(-1).phase, 'completed');
  assert.ok(state.saves.some((entry) => entry.phase === 'attempted'));
  assert.ok(state.saves.some((entry) => entry.phase === 'observed'));
  assert.ok(state.saves.some((entry) => entry.phase === 'reconciled'));

  const removalCount = state.removals.length;
  const again = await state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
  assert.equal(again.complete, true);
  assert.equal(state.removals.length, removalCount);
});

test('already absent effects reconcile without a removal attempt and remain distinct in the report', async () => {
  const state = harness();
  const plan = await state.api.inspect({ mode: 'application' });
  state.present.clear();
  const result = await state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
  assert.equal(result.complete, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.absent, ['item-core', 'item-entry']);
  assert.equal(state.removals.length, 0);
});

test('coverage and active mutation facts prevent selection and effects', async () => {
  const incomplete = harness(snapshot({ coverage: ['application'] }));
  const purge = await incomplete.api.inspect({ mode: 'purge' });
  assert.equal(purge.complete, false);
  assert.equal(purge.ready, false);
  assert.equal(purge.selected.length, 0);
  assert.ok(purge.preserved.every((entry) => entry.reasons.includes('coverage-incomplete')));
  await assert.rejects(
    () => incomplete.api.remove({ mode: 'purge', planDigest: purge.digest, confirmation: 'REMOVE' }),
    /coverage is incomplete/u,
  );
  assert.equal(incomplete.removals.length, 0);

  const active = harness(snapshot({ mutationActive: true }));
  const application = await active.api.inspect({ mode: 'application' });
  assert.equal(application.complete, true);
  assert.equal(application.ready, false);
  assert.equal(application.selected.length, 0);
  assert.ok(application.preserved.every((entry) => entry.reasons.includes('mutation-active')));
  await assert.rejects(
    () => active.api.remove({ mode: 'application', planDigest: application.digest, confirmation: 'REMOVE' }),
    /not ready/u,
  );
});

test('a dependency on preserved state preserves the dependent item', async () => {
  const selected = snapshot();
  selected.items = selected.items.map((entry) => entry.identity === 'item-entry'
    ? { ...entry, after: ['item-managed'] }
    : entry);
  const plan = await harness(selected).api.inspect({ mode: 'application' });
  assert.deepEqual(plan.selected.map((entry) => entry.identity), ['item-core']);
  assert.deepEqual(preserved(plan, 'item-entry').reasons, ['dependency-preserved']);
});

test('locally adopted state remains eligible while foreign state never acquires effects', async () => {
  const selected = snapshot();
  selected.items = selected.items.map((entry) => entry.identity === 'item-core'
    ? { ...entry, provenance: 'adopted' }
    : entry);
  const plan = await harness(selected).api.inspect({ mode: 'application' });
  assert.deepEqual(plan.selected.map((entry) => [entry.identity, entry.provenance]), [
    ['item-core', 'adopted'],
    ['item-entry', 'created'],
  ]);
  assert.deepEqual(preserved(plan, 'item-foreign').reasons, ['foreign']);
});

test('plan drift after one reconciled effect fails before the next effect', async () => {
  let state;
  let count = 0;
  state = harness(snapshot(), {
    removeEffect(input, present) {
      present.delete(input.effect.identity);
      count += 1;
      if (count === 1) state.setSnapshot(snapshot({ protectedReferences: ['reference-active', 'reference-new'] }));
    },
  });
  const plan = await state.api.inspect({ mode: 'application' });
  await assert.rejects(
    () => state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' }),
    /plan changed/u,
  );
  assert.equal(state.removals.length, 1);
});

test('an interrupted attempt is observed and reconciled without replay when absence is already exact', async () => {
  let interrupt = true;
  const state = harness(snapshot(), {
    removeEffect(input, present) {
      present.delete(input.effect.identity);
      if (interrupt) throw new Error('simulated interruption');
    },
  });
  const plan = await state.api.inspect({ mode: 'application' });
  await assert.rejects(
    () => state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' }),
    /simulated interruption/u,
  );
  assert.equal(state.records.get('application').phase, 'attempted');
  interrupt = false;
  const result = await state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
  assert.equal(result.complete, true);
  assert.equal(state.removals.filter((entry) => entry.effect.identity === 'effect-item-core-data').length, 1);
});

test('a present retryable attempted effect receives only one bounded exact retry', async () => {
  let attempts = 0;
  const state = harness(snapshot(), {
    removeEffect(input, present) {
      attempts += 1;
      if (attempts > 1) present.delete(input.effect.identity);
    },
  });
  const plan = await state.api.inspect({ mode: 'application' });
  const result = await state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
  assert.equal(result.complete, true);
  assert.equal(state.removals.filter((entry) => entry.effect.identity === 'effect-item-core-data').length, 2);
});

test('ambiguous observations and substituted bindings fail closed', async () => {
  const ambiguous = harness(snapshot(), {
    observeEffect(input) { return { identity: input.effect.identity, state: 'ambiguous', retryable: false }; },
  });
  const plan = await ambiguous.api.inspect({ mode: 'application' });
  await assert.rejects(
    () => ambiguous.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' }),
    /ambiguous/u,
  );
  assert.equal(ambiguous.removals.length, 0);

  const substituted = harness(snapshot(), {
    bindEffect(input) {
      return {
        protocol: APPLICATION_REMOVAL_PROTOCOL,
        mode: input.mode,
        item: input.item,
        identity: 'effect-substituted',
        planDigest: input.planDigest,
        bound: true,
      };
    },
  });
  const selected = await substituted.api.inspect({ mode: 'application' });
  await assert.rejects(
    () => substituted.api.remove({ mode: 'application', planDigest: selected.digest, confirmation: 'REMOVE' }),
    /exact authority/u,
  );
  assert.equal(substituted.removals.length, 0);
});

test('malformed identity, provenance, effects, dependencies, and cycles create no plan authority', async () => {
  const duplicate = snapshot();
  duplicate.items[1].effects[0].identity = duplicate.items[0].effects[0].identity;
  await assert.rejects(() => harness(duplicate).api.inspect({ mode: 'application' }), /duplicate identities/u);

  const foreignEffect = snapshot();
  foreignEffect.items.at(-1).effects = [effect('effect-foreign', 0, true)];
  await assert.rejects(() => harness(foreignEffect).api.inspect({ mode: 'application' }), /foreign removal item/u);

  const unknown = snapshot();
  unknown.items[0].after = ['item-unknown'];
  await assert.rejects(() => harness(unknown).api.inspect({ mode: 'application' }), /dependency is unavailable/u);

  const cycle = snapshot();
  cycle.items = cycle.items.map((entry) => {
    if (entry.identity === 'item-core') return { ...entry, after: ['item-entry'] };
    if (entry.identity === 'item-entry') return { ...entry, after: ['item-core'] };
    return entry;
  });
  await assert.rejects(() => harness(cycle).api.inspect({ mode: 'application' }), /contains a cycle/u);

  const noTerminal = snapshot();
  noTerminal.items[0].effects.at(-1).terminal = false;
  await assert.rejects(() => harness(noTerminal).api.inspect({ mode: 'application' }), /terminal effect/u);

  const oversized = snapshot({
    items: ['first', 'second'].map((identity) => item(identity, {
      effects: Array.from({ length: 4097 }, (_, index) => effect(`effect-${identity}-${index}`, 0, index === 4096)),
    })),
  });
  await assert.rejects(() => harness(oversized).api.inspect({ mode: 'application' }), /effect bound/u);
});

test('a corrupt journal cannot reintroduce an item after another effect group', async () => {
  let interrupt = true;
  const state = harness(snapshot(), {
    removeEffect() {
      if (interrupt) throw new Error('simulated interruption');
    },
  });
  const plan = await state.api.inspect({ mode: 'application' });
  await assert.rejects(
    () => state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' }),
    /simulated interruption/u,
  );
  const corrupt = structuredClone(state.records.get('application'));
  corrupt.effects = [
    { ...corrupt.effects[0], terminal: true },
    { ...corrupt.effects[2], terminal: true },
    corrupt.effects[1],
    corrupt.effects[3],
  ];
  state.records.set('application', corrupt);
  interrupt = false;
  await assert.rejects(
    () => state.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' }),
    /not contiguous/u,
  );
  assert.equal(state.removals.length, 1);
});

test('an empty complete plan still requires exact confirmation and persists a terminal receipt', async () => {
  const empty = harness(snapshot({ items: [] }));
  const plan = await empty.api.inspect({ mode: 'application' });
  await assert.rejects(
    () => empty.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE!' }),
    /exact literal REMOVE/u,
  );
  const result = await empty.api.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
  assert.equal(result.complete, true);
  assert.equal(result.effectCount, 0);
  assert.equal(empty.saves.length, 1);
  assert.equal(empty.saves[0].phase, 'completed');
});
