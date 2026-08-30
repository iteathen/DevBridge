import assert from 'node:assert/strict';
import test from 'node:test';
import { createConstructionRetention, CONSTRUCTION_RETENTION_PROTOCOL } from '../src/app/construction-retention.js';

const current = 'subject-11111111111111111111111111111111';
const accepted = 'subject-22222222222222222222222222222222';
const recoverable = 'subject-33333333333333333333333333333333';
const retained = 'subject-44444444444444444444444444444444';
const ambiguous = 'subject-55555555555555555555555555555555';
const obsolete = 'subject-66666666666666666666666666666666';

function effect(identity, bytes, terminal = false) {
  return { identity, bytes, terminal };
}

function subject(identity, changes = {}) {
  return {
    identity,
    selected: false,
    recoverable: false,
    retained: false,
    ambiguous: false,
    references: [],
    effects: [effect(`effect-${identity.slice(8, 16)}-data`, 10), effect(`effect-${identity.slice(8, 16)}-records`, 0, true)],
    ...changes,
  };
}

function snapshot(changes = {}) {
  return {
    generation: 'retention-generation-v1',
    leaseActive: false,
    protectedReferences: ['reference-accepted'],
    subjects: [
      subject(current, { selected: true }),
      subject(accepted, { references: ['reference-accepted'] }),
      subject(recoverable, { recoverable: true }),
      subject(retained, { retained: true }),
      subject(ambiguous, { ambiguous: true }),
      subject(obsolete),
    ],
    ...changes,
  };
}

function harness(initial = snapshot(), onProgress = null) {
  let currentSnapshot = structuredClone(initial);
  const records = new Map();
  const present = new Set(currentSnapshot.subjects.flatMap((entry) => entry.effects.map((item) => item.identity)));
  const attempts = [];
  const saves = [];
  const api = createConstructionRetention({
    source: { async snapshot() { return structuredClone(currentSnapshot); } },
    journal: {
      async load(identity) { return structuredClone(records.get(identity)); },
      async save(identity, value) { records.set(identity, structuredClone(value)); saves.push(structuredClone(value)); },
    },
    effects: {
      async bind({ identity, planDigest }) { return { identity, planDigest, bound: true }; },
      async observe({ effect: item }) {
        return { identity: item.identity, state: present.has(item.identity) ? 'present' : 'absent', retryable: true };
      },
      async remove({ identity, effect: item }) {
        attempts.push({ identity, effect: item.identity });
        present.delete(item.identity);
      },
    },
    onProgress,
  });
  return {
    api,
    attempts,
    saves,
    records,
    present,
    setSnapshot(value) { currentSnapshot = structuredClone(value); },
  };
}

test('retention inventory is deterministic, bounded, path-free, and classifies every protection fact', async () => {
  const first = harness();
  const second = harness({ ...snapshot(), subjects: [...snapshot().subjects].reverse() });
  const a = await first.api.inspect();
  const b = await second.api.inspect();
  assert.equal(a.protocol, CONSTRUCTION_RETENTION_PROTOCOL);
  assert.equal(a.digest, b.digest);
  assert.deepEqual(
    Object.fromEntries(a.subjects.map((entry) => [entry.identity, entry.classification])),
    {
      [current]: 'current',
      [accepted]: 'accepted',
      [recoverable]: 'recoverable',
      [retained]: 'retained',
      [ambiguous]: 'ambiguous',
      [obsolete]: 'obsolete',
    },
  );
  assert.equal(a.subjects.find((entry) => entry.identity === obsolete).eligible, true);
  assert.equal(JSON.stringify(a).includes('path'), false);
  assert.equal(JSON.stringify(a).includes('effect-'), false);
});

test('retirement requires the exact current plan and crosses every effect in durable order', async () => {
  const state = harness();
  const plan = await state.api.inspect();
  await assert.rejects(() => state.api.retire({ identity: obsolete, planDigest: '0'.repeat(64) }), /current plan/u);
  const result = await state.api.retire({ identity: obsolete, planDigest: plan.digest });
  assert.equal(result.complete, true);
  assert.equal(result.completedEffects, 2);
  assert.equal(result.reconciledBytes, 10);
  assert.deepEqual(state.attempts.map((entry) => entry.effect), ['effect-66666666-data', 'effect-66666666-records']);
  assert.deepEqual(
    state.saves.map((entry) => entry.phase),
    ['planned', 'attempted', 'observed', 'reconciled', 'planned', 'attempted', 'observed', 'reconciled', 'completed'],
  );
  const again = await state.api.retire({ identity: obsolete, planDigest: plan.digest });
  assert.equal(again.complete, true);
  assert.equal(state.attempts.length, 2);
});

test('progress stud reports bounded neutral phases and cannot affect retirement authority', async () => {
  const progress = [];
  const state = harness(snapshot(), (event) => {
    progress.push(structuredClone(event));
    if (event.phase === 'attempted') throw new Error('observer unavailable');
    if (event.phase === 'observed') return Promise.reject(new Error('observer rejected'));
    return null;
  });
  const plan = await state.api.inspect();
  const result = await state.api.retire({ identity: obsolete, planDigest: plan.digest });
  assert.equal(result.complete, true);
  assert.ok(progress.some((entry) => entry.phase === 'planning' && entry.total == null));
  assert.ok(progress.some((entry) => entry.phase === 'binding' && entry.total === 2));
  assert.ok(progress.some((entry) => entry.phase === 'attempted' && entry.attempt === 1));
  assert.ok(progress.some((entry) => entry.phase === 'reconciled' && entry.completed === 1 && entry.total === 2));
  assert.equal(progress.some((entry) => entry.phase === 'completed'), false);
  for (const entry of progress) assert.deepEqual(Object.keys(entry).sort(), ['attempt', 'completed', 'phase', 'total']);
  assert.doesNotMatch(JSON.stringify(progress), /subject-|effect-|path|identity|digest/u);
});

test('progress begins before an awaited source snapshot completes', async () => {
  const progress = [];
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const api = createConstructionRetention({
    source: { async snapshot() { await waiting; return snapshot(); } },
    journal: { load: async () => null, save: async () => {} },
    effects: {
      bind: async ({ identity, planDigest }) => ({ identity, planDigest, bound: true }),
      observe: async ({ effect: item }) => ({ identity: item.identity, state: 'absent', retryable: false }),
      remove: async () => {},
    },
    onProgress: (event) => progress.push(event),
  });
  const inspection = api.inspect();
  assert.deepEqual(progress, [{ phase: 'planning', completed: 0, total: null, attempt: 0 }]);
  release();
  await inspection;
});

test('current, accepted, recoverable, retained, and ambiguous subjects cannot cross retirement', async () => {
  for (const identity of [current, accepted, recoverable, retained, ambiguous]) {
    const state = harness();
    const plan = await state.api.inspect();
    await assert.rejects(() => state.api.retire({ identity, planDigest: plan.digest }), /protected as/u);
    assert.equal(state.attempts.length, 0);
  }
});

test('an active lease disables inventory eligibility and mutation', async () => {
  const state = harness(snapshot({ leaseActive: true }));
  const plan = await state.api.inspect();
  assert.equal(plan.subjects.every((entry) => !entry.eligible), true);
  await assert.rejects(() => state.api.retire({ identity: obsolete, planDigest: plan.digest }), /lease is active/u);
});

test('plan, protection, and effect drift fail before the next effect', async () => {
  const state = harness();
  const plan = await state.api.inspect();
  let removals = 0;
  const base = state.api;
  const effects = {
    async observe(input) {
      return { identity: input.effect.identity, state: state.present.has(input.effect.identity) ? 'present' : 'absent', retryable: true };
    },
    async remove(input) {
      removals += 1;
      state.present.delete(input.effect.identity);
      if (removals === 1) state.setSnapshot(snapshot({ protectedReferences: ['reference-accepted', 'reference-new'] }));
    },
  };
  const drifted = createConstructionRetention({
    source: { snapshot: async () => state.records.get('snapshot') ?? snapshot({ protectedReferences: removals ? ['reference-accepted', 'reference-new'] : ['reference-accepted'] }) },
    journal: {
      load: (identity) => state.records.get(identity),
      save: (identity, value) => { state.records.set(identity, structuredClone(value)); },
    },
    effects: {
      bind: async ({ identity, planDigest }) => ({ identity, planDigest, bound: true }),
      ...effects,
    },
  });
  void base;
  await assert.rejects(() => drifted.retire({ identity: obsolete, planDigest: plan.digest }), /plan changed/u);
  assert.equal(removals, 1);
});

test('interrupted attempted effects are observed before one bounded exact retry', async () => {
  const progress = [];
  const state = harness(snapshot(), (event) => progress.push(event));
  const plan = await state.api.inspect();
  const selected = snapshot().subjects.find((entry) => entry.identity === obsolete);
  state.records.set(obsolete, {
    protocol: CONSTRUCTION_RETENTION_PROTOCOL,
    identity: obsolete,
    planDigest: plan.digest,
    generation: 'retention-generation-v1',
    revision: 2,
    cursor: 0,
    phase: 'attempted',
    attempts: 1,
    effects: selected.effects,
  });
  const result = await state.api.retire({ identity: obsolete, planDigest: plan.digest });
  assert.equal(result.complete, true);
  assert.equal(state.attempts.length, 2);
  assert.ok(progress.some((entry) => entry.phase === 'attempted' && entry.attempt === 1));
});

test('ambiguous effect observation fails closed without another removal', async () => {
  const state = harness();
  const plan = await state.api.inspect();
  const selected = snapshot().subjects.find((entry) => entry.identity === obsolete);
  state.records.set(obsolete, {
    protocol: CONSTRUCTION_RETENTION_PROTOCOL,
    identity: obsolete,
    planDigest: plan.digest,
    generation: 'retention-generation-v1',
    revision: 2,
    cursor: 0,
    phase: 'attempted',
    attempts: 1,
    effects: selected.effects,
  });
  const api = createConstructionRetention({
    source: { snapshot: async () => snapshot() },
    journal: {
      load: (identity) => state.records.get(identity),
      save: (identity, value) => state.records.set(identity, structuredClone(value)),
    },
    effects: {
      bind: async ({ identity, planDigest }) => ({ identity, planDigest, bound: true }),
      observe: async ({ effect: item }) => ({ identity: item.identity, state: 'ambiguous', retryable: false }),
      remove: async () => { throw new Error('must not run'); },
    },
  });
  await assert.rejects(() => api.retire({ identity: obsolete, planDigest: plan.digest }), /ambiguous/u);
});

test('malformed topology cannot create cleanup authority', async () => {
  const duplicate = snapshot();
  duplicate.subjects[5].effects[0].identity = duplicate.subjects[0].effects[0].identity;
  await assert.rejects(() => harness(duplicate).api.inspect(), /duplicate identities/u);
  await assert.rejects(() => harness(snapshot({ subjects: snapshot().subjects.map((entry) => ({ ...entry, selected: false })) })).api.inspect(), /exactly one current/u);
  const noTerminal = snapshot();
  noTerminal.subjects[5].effects.at(-1).terminal = false;
  await assert.rejects(() => harness(noTerminal).api.inspect(), /terminal effect/u);
});
