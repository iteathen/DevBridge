import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createConditionalItemSet } from '../src/runtime/conditional-item-set.js';

function entry(identity, value) {
  return Object.freeze({ identity, value });
}

function memory(initial = null, intercept = null) {
  let current = initial;
  let comparisons = 0;
  return {
    records: {
      async read() { return current ?? { revision: null, items: [] }; },
      async compare(request) {
        comparisons += 1;
        if (intercept) {
          const selected = await intercept({ request, current, comparisons });
          if (selected) { current = selected; return { accepted: false, snapshot: current }; }
        }
        if ((current?.revision ?? null) !== request.revision) return { accepted: false, snapshot: current };
        current = { revision: `revision-${comparisons}`, items: request.items };
        return { accepted: true, snapshot: current };
      },
    },
    current() { return current; },
    comparisons() { return comparisons; },
  };
}

test('conditional item changes preserve an unrelated concurrent winner', async () => {
  const original = entry('one', { count: 1 });
  const desired = entry('one', { count: 2 });
  const unrelated = entry('other', { count: 9 });
  const store = memory({ revision: 'revision-a', items: [original] }, ({ comparisons }) => (
    comparisons === 1 ? { revision: 'revision-b', items: [original, unrelated] } : null
  ));
  const set = createConditionalItemSet({ records: store.records });
  const accepted = await set.apply({ changes: [{ identity: 'one', before: original, after: desired }] });
  assert.deepEqual(accepted.items, [desired, unrelated]);
  assert.equal(store.comparisons(), 2);
});

test('conditional item replay is idempotent and same-item drift fails closed', async () => {
  const before = entry('one', { count: 1 });
  const after = entry('one', { count: 2 });
  const store = memory({ revision: 'revision-a', items: [after] });
  const set = createConditionalItemSet({ records: store.records });
  assert.deepEqual(await set.apply({ changes: [{ identity: 'one', before, after }] }), store.current());
  assert.equal(store.comparisons(), 0);

  const changed = memory({ revision: 'revision-a', items: [entry('one', { count: 3 })] });
  await assert.rejects(
    () => createConditionalItemSet({ records: changed.records }).apply({ changes: [{ identity: 'one', before, after }] }),
    /changed outside/u,
  );
  assert.equal(changed.comparisons(), 0);
});

test('conditional item set rejects empty results and malformed comparison evidence', async () => {
  const before = entry('one', { count: 1 });
  const store = memory({ revision: 'revision-a', items: [before] });
  await assert.rejects(
    () => createConditionalItemSet({ records: store.records }).apply({ changes: [{ identity: 'one', before, after: null }] }),
    /cannot become empty/u,
  );

  const malformed = createConditionalItemSet({ records: {
    async read() { return { revision: 'revision-a', items: [before] }; },
    async compare() { return { accepted: true, snapshot: { revision: null, items: [before] } }; },
  } });
  await assert.rejects(
    () => malformed.apply({ changes: [{ identity: 'one', before, after: entry('one', { count: 2 }) }] }),
    /empty state is invalid/u,
  );
  await assert.rejects(
    () => createConditionalItemSet({ records: store.records }).apply({
      changes: [{ identity: 'one', before, after: entry('one', { missing: undefined }) }],
    }),
    /exact JSON/u,
  );
});

test('conditional item set stops after its fixed contention bound', async () => {
  const before = entry('one', { count: 1 });
  let revision = 0;
  const set = createConditionalItemSet({
    attempts: 2,
    records: {
      async read() { return { revision: 'revision-0', items: [before] }; },
      async compare() {
        revision += 1;
        return { accepted: false, snapshot: { revision: `revision-${revision}`, items: [before] } };
      },
    },
  });
  await assert.rejects(
    () => set.apply({ changes: [{ identity: 'one', before, after: entry('one', { count: 2 }) }] }),
    /changed continuously/u,
  );
});

test('conditional item set remains import-isolated and topology-neutral', async () => {
  const source = await readFile(new URL('../src/runtime/conditional-item-set.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s/mu);
  assert.doesNotMatch(source, /(?:receipt|installer|wrapper|component|repository|provider|virtual machine|guest|uninstall)/iu);
});
