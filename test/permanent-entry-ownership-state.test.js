import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createConditionalItemSet } from '../src/runtime/conditional-item-set.js';
import {
  createOwnershipState,
  OWNERSHIP_VALUE_PROTOCOL,
} from '../src/install/permanent-entry-installer/ownership-state.mjs';

function memory() {
  let record = null;
  let revision = 0;
  const records = {
    async read() { return record ?? { revision: null, items: [] }; },
    async compare({ revision: expected, items }) {
      if ((record?.revision ?? null) !== expected) return { accepted: false, snapshot: record };
      revision += 1;
      record = { revision: `revision-${revision}`, items };
      return { accepted: true, snapshot: record };
    },
  };
  return { collection: createConditionalItemSet({ records }), current: () => record };
}

test('ownership state establishes protected control then reserves and completes one value', async () => {
  const store = memory();
  const state = createOwnershipState({
    collection: store.collection,
    identifier: () => '11111111-1111-4111-8111-111111111111',
  });
  const opened = await state.open();
  assert.deepEqual(opened.items, [{
    identity: 'control',
    provenance: 'created',
    value: { phase: 'control', protected: true, protocol: OWNERSHIP_VALUE_PROTOCOL },
  }]);

  const reservation = await state.reserve({ identity: 'item-one', provenance: 'created', request: { digest: 'a' } });
  assert.equal(reservation.value.phase, 'reserved');
  const accepted = await state.complete({ reservation, value: { digest: 'b' } });
  assert.equal(accepted.value.phase, 'complete');
  assert.deepEqual(accepted.value.value, { digest: 'b' });
  assert.deepEqual((await state.read('item-one')), accepted);
});

test('ownership state preserves an existing collection and clears only an exact reservation', async () => {
  const store = memory();
  await store.collection.apply({ changes: [{
    identity: 'other',
    before: null,
    after: { identity: 'other', provenance: 'created', value: { external: true } },
  }] });
  const state = createOwnershipState({
    collection: store.collection,
    identifier: () => '22222222-2222-4222-8222-222222222222',
  });
  const opened = await state.open();
  assert.equal(opened.items.find((entry) => entry.identity === 'control').provenance, 'adopted');
  assert.deepEqual(opened.items.find((entry) => entry.identity === 'other').value, { external: true });

  const reservation = await state.reserve({ identity: 'temporary-one', provenance: 'created', request: { path: 'opaque' } });
  const cleared = await state.clear({ item: reservation });
  assert.equal(cleared.items.some((entry) => entry.identity === 'temporary-one'), false);
  assert.equal(cleared.items.some((entry) => entry.identity === 'other'), true);
});

test('ownership state rejects conflicting pending state and control replacement', async () => {
  const store = memory();
  const identifiers = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const state = createOwnershipState({ collection: store.collection, identifier: () => identifiers.shift() });
  await state.reserve({ identity: 'item-one', provenance: 'created', request: { digest: 'a' } });
  await assert.rejects(
    () => state.reserve({ identity: 'item-one', provenance: 'created', request: { digest: 'b' } }),
    /another pending/u,
  );
  await assert.rejects(
    () => state.reserve({ identity: 'control', provenance: 'created', request: { digest: 'a' } }),
    /cannot replace control/u,
  );
});

test('ownership state contains no neighboring or external topology', async () => {
  const source = await readFile(new URL('../src/install/permanent-entry-installer/ownership-state.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:wrapper|component|repository|provider|virtual machine|guest|uninstall|receipt)/iu);
});

test('ownership record exact retry does not publish another collection revision', async () => {
  const store = memory();
  const state = createOwnershipState({
    collection: store.collection,
    identifier: () => '55555555-5555-4555-8555-555555555555',
  });
  const input = { identity: 'item-one', provenance: 'created', request: { digest: 'a' }, value: { digest: 'b' } };
  const first = await state.record(input);
  const accepted = store.current();
  assert.deepEqual(await state.record(input), first);
  assert.equal(store.current(), accepted);
});

test('completed value replacement is one exact CAS with new identity and no reserved crash window', async () => {
  const store = memory();
  const state = createOwnershipState({ collection: store.collection });
  const first = await state.record({ identity: 'item-one', provenance: 'created', request: { kind: 'opaque' }, value: { digest: 'old' } });
  const oldSnapshot = structuredClone(store.current());
  const after = await state.replace({ item: first, value: { digest: 'new' } });
  assert.equal(after.value.phase, 'complete');
  assert.notEqual(after.value.operation, first.value.operation);
  assert.deepEqual(after.value.request, first.value.request);
  assert.equal(after.provenance, first.provenance);
  assert.equal(Number(store.current().revision.split('-')[1]), Number(oldSnapshot.revision.split('-')[1]) + 1);
  const accepted = store.current();
  await assert.rejects(() => state.replace({ item: first, value: { digest: 'stale' } }));
  assert.deepEqual(store.current(), accepted);
  assert.equal(first.value.value.digest, 'old');
});

test('value replacement rejects reserved, control and malformed inputs without mutation', async () => {
  const store = memory();
  const state = createOwnershipState({ collection: store.collection });
  const pending = await state.reserve({ identity: 'pending', provenance: 'created', request: { kind: 'opaque' } });
  const anchor = await state.read('control');
  const before = structuredClone(store.current());
  for (const raw of [{ item: pending, value: {} }, { item: anchor, value: {} }, { item: pending, value: {}, extra: true }]) {
    await assert.rejects(() => state.replace(raw));
  }
  assert.deepEqual(store.current(), before);
});

test('value replacement rejects reused operation identity and invalid JSON before publication', async () => {
  const store = memory();
  const id = '66666666-6666-4666-8666-666666666666';
  const state = createOwnershipState({ collection: store.collection, identifier: () => id });
  const first = await state.record({ identity: 'item-one', provenance: 'created', request: {}, value: {} });
  const before = structuredClone(store.current());
  await assert.rejects(() => state.replace({ item: first, value: {} }), /new operation identity/u);
  const fresh = createOwnershipState({ collection: store.collection });
  await assert.rejects(() => fresh.replace({ item: first, value: { invalid: undefined } }));
  assert.deepEqual(store.current(), before);
});
