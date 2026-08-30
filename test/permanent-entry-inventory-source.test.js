import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnershipInventorySource } from '../src/install/permanent-entry-installer/ownership-inventory-source.mjs';

const COLLECTION = 'test/collection-v1';
const VALUE = 'test/value-v1';
const GENERATION = `generation-${'a'.repeat(64)}`;

function control() {
  return { identity: 'control', provenance: 'created', value: { protocol: VALUE, phase: 'control', protected: true } };
}

function completed(identity, provenance = 'created') {
  return {
    identity,
    provenance,
    value: {
      protocol: VALUE,
      phase: 'complete',
      operation: 'operation',
      request: { local: true },
      value: { identity: `set-${identity}`, digest: 'b'.repeat(64), bytes: 1 },
    },
  };
}

function reserved(identity) {
  return {
    identity,
    provenance: 'created',
    value: { protocol: VALUE, phase: 'reserved', operation: 'operation', request: { local: true }, value: null },
  };
}

function source(items) {
  return createOwnershipInventorySource({
    identity: 'payload',
    collection: { async read() {
      return { protocol: COLLECTION, revision: 1, epoch: 'epoch', previousDigest: null, generation: GENERATION, items };
    } },
    collectionProtocol: COLLECTION,
    valueProtocol: VALUE,
    controlIdentity: 'control',
    include: (identity) => identity.startsWith('owned.'),
    relate({ identity, available }) {
      return { protections: [], references: [], after: identity === 'owned.tree' ? available.filter((entry) => entry !== identity) : [] };
    },
  });
}

test('local ownership source projects only completed selected values and neutral relationships', async () => {
  const selected = source([
    completed('owned.tree', 'adopted'),
    control(),
    completed('ignored.foreign'),
    completed('owned.file'),
  ]);
  const observed = await selected.observe({ identity: 'payload' });
  assert.equal(observed.complete, true);
  assert.equal(observed.generation, GENERATION);
  assert.deepEqual(observed.items.map((entry) => entry.identity), ['owned.file', 'owned.tree']);
  assert.deepEqual(observed.items.find((entry) => entry.identity === 'owned.tree').after, ['owned.file']);
  assert.equal(observed.items.find((entry) => entry.identity === 'owned.tree').provenance, 'adopted');
});

test('pending selected ownership withholds completeness without claiming its value', async () => {
  const observed = await source([control(), completed('owned.file'), reserved('owned.tree')]).observe({ identity: 'payload' });
  assert.equal(observed.complete, false);
  assert.deepEqual(observed.items.map((entry) => entry.identity), ['owned.file']);
});

test('an absent receipt withholds coverage while private descriptor validation remains downstream', async () => {
  const absent = createOwnershipInventorySource({
    identity: 'payload',
    collection: { async read() { return null; } },
    collectionProtocol: COLLECTION,
    valueProtocol: VALUE,
    controlIdentity: 'control',
    include: () => true,
    relate: () => ({ protections: [], references: [], after: [] }),
  });
  assert.deepEqual(await absent.observe({ identity: 'payload' }), {
    identity: 'payload', generation: 'generation-absent', complete: false, items: [],
  });
  const malformed = completed('owned.file');
  malformed.value.value.digest = 'wrong';
  const observed = await source([control(), malformed]).observe({ identity: 'payload' });
  assert.equal(observed.items[0].value.digest, 'wrong');
});

test('control and selected value protocols are strict while unrelated values remain isolated', async () => {
  const unrelated = completed('ignored.foreign');
  unrelated.value = { another: 'protocol' };
  assert.equal((await source([control(), unrelated, completed('owned.file')]).observe({ identity: 'payload' })).complete, true);

  const badControl = control();
  badControl.value.protected = false;
  await assert.rejects(() => source([badControl, completed('owned.file')]).observe({ identity: 'payload' }), /control/u);

  const badSelected = completed('owned.file');
  badSelected.value.protocol = 'wrong';
  await assert.rejects(() => source([control(), badSelected]).observe({ identity: 'payload' }), /selected item/u);
});
