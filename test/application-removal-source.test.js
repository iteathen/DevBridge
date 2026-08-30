import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPLICATION_REMOVAL_PROTOCOL,
  createApplicationRemoval,
  createApplicationRemovalSource,
} from '../src/app/application-removal.js';

function item(identity) {
  return {
    identity,
    scope: 'payload',
    provenance: 'created',
    protections: [],
    references: [],
    after: [],
    effects: [{ identity: `effect-${identity}`, bytes: 1, terminal: true }],
  };
}

function contributor(identity, changes = {}) {
  const value = {
    generation: `generation-${identity}`,
    coverage: ['application', 'purge'],
    mutationActive: false,
    protectedReferences: [],
    items: [item(`item-${identity}`)],
    ...changes,
  };
  return { identity, async snapshot() { return structuredClone(value); } };
}

test('source aggregation is deterministic and mode coverage requires every configured contributor', async () => {
  const first = contributor('first');
  const second = contributor('second', { coverage: ['application'] });
  const required = { application: ['first', 'second'], purge: ['first', 'second'] };
  const forward = createApplicationRemovalSource({ contributors: [first, second], required });
  const reverse = createApplicationRemovalSource({ contributors: [second, first], required });
  const [left, right] = await Promise.all([forward.snapshot(), reverse.snapshot()]);

  assert.equal(left.protocol, APPLICATION_REMOVAL_PROTOCOL);
  assert.deepEqual(left.coverage, ['application']);
  assert.equal(left.generation, right.generation);
  assert.deepEqual(left.items.map((entry) => entry.identity), ['item-first', 'item-second']);
});

test('a missing required contributor leaves every affected mode explicitly incomplete', async () => {
  const source = createApplicationRemovalSource({
    contributors: [contributor('first')],
    required: { application: ['first', 'missing'], purge: ['first', 'missing'] },
  });
  const api = createApplicationRemoval({
    source,
    journal: { async run(_subject, operation) { return operation({ async load() {}, async save() {} }); } },
    effects: { async bind() {}, async observe() {}, async remove() {} },
  });
  const plan = await api.inspect({ mode: 'application' });
  assert.equal(plan.complete, false);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.preserved[0].reasons, ['coverage-incomplete']);
});

test('activity and protected references are combined without contributor topology leaking into items', async () => {
  const source = createApplicationRemovalSource({
    contributors: [
      contributor('first', { protectedReferences: ['reference-one'] }),
      contributor('second', { mutationActive: true, protectedReferences: ['reference-one', 'reference-two'] }),
    ],
    required: { application: ['first', 'second'], purge: ['first', 'second'] },
  });
  const snapshot = await source.snapshot();
  assert.equal(snapshot.mutationActive, true);
  assert.deepEqual(snapshot.protectedReferences, ['reference-one', 'reference-two']);
  assert.equal(JSON.stringify(snapshot).includes('contributor'), false);
});

test('duplicate contributor and malformed fragment identities fail before creating plan authority', async () => {
  assert.throws(
    () => createApplicationRemovalSource({
      contributors: [contributor('same'), contributor('same')],
      required: { application: ['same'], purge: ['same'] },
    }),
    /duplicate identities/u,
  );
  const source = createApplicationRemovalSource({
    contributors: [contributor('first', { generation: '../escape' })],
    required: { application: ['first'], purge: ['first'] },
  });
  await assert.rejects(() => source.snapshot(), /generation is invalid/u);
});
