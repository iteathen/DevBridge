import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  PROTECTED_AUTHORITY_OBSERVATION_PROTOCOL,
  PROTECTED_AUTHORITY_RECONCILIATION_JOURNAL_PROTOCOL,
  PROTECTED_AUTHORITY_RECONCILIATION_PROTOCOL,
  reconcileProtectedAuthority,
} from '../src/setup/protected-authority-reconciliation.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fixture({
  activeGeneration = null,
  running = false,
  stagedGeneration = null,
  retainedGenerations = [],
  health = {},
  failObservationAt = null,
  failJournalSaveWhen = null,
} = {}) {
  const state = {
    ownership: activeGeneration == null && stagedGeneration == null ? 'absent' : 'owned',
    activeGeneration,
    stagedGeneration,
    running,
    retainedGenerations: [...retainedGenerations],
  };
  let journal = null;
  let observationCount = 0;
  const events = [];
  const calls = { stage: 0, quiesce: 0, promote: 0, start: 0, restore: 0, verify: 0, health: 0 };

  const observe = async () => {
    observationCount += 1;
    events.push(`observe:${observationCount}`);
    if (failObservationAt === observationCount) throw new Error('injected observation interruption');
    return {
      protocol: PROTECTED_AUTHORITY_OBSERVATION_PROTOCOL,
      ownership: state.ownership,
      activeGeneration: state.activeGeneration,
      stagedGeneration: state.stagedGeneration,
      running: state.running,
      retainedGenerations: [...state.retainedGenerations],
    };
  };

  const ports = {
    journal: {
      async load() { events.push('journal:load'); return clone(journal); },
      async save(value) {
        if (typeof failJournalSaveWhen === 'function' && failJournalSaveWhen(value)) throw new Error('injected journal interruption');
        journal = clone(value);
        const pending = value.pending == null ? '-' : `${value.pending.effect}:${value.pending.status}:${value.pending.attempt}`;
        events.push(`journal:save:${value.phase}:${pending}`);
      },
    },
    observe,
    async stage({ generation }) {
      calls.stage += 1;
      events.push(`effect:stage:${generation}`);
      state.ownership = 'owned';
      state.stagedGeneration = generation;
    },
    async verify({ generation }) {
      calls.verify += 1;
      events.push(`verify:${generation}`);
      return { generation, verified: true };
    },
    async quiesce({ generation }) {
      calls.quiesce += 1;
      events.push(`effect:quiesce:${generation}`);
      assert.equal(state.activeGeneration, generation);
      state.running = false;
    },
    async promote({ generation, previousGeneration }) {
      calls.promote += 1;
      events.push(`effect:promote:${generation}`);
      assert.equal(state.stagedGeneration, generation);
      assert.equal(state.activeGeneration, previousGeneration);
      if (previousGeneration != null) state.retainedGenerations.push(previousGeneration);
      state.activeGeneration = generation;
      state.stagedGeneration = null;
      state.running = false;
      state.ownership = 'owned';
    },
    async start({ generation }) {
      calls.start += 1;
      events.push(`effect:start:${generation}`);
      assert.equal(state.activeGeneration, generation);
      state.running = true;
    },
    async health({ generation }) {
      calls.health += 1;
      events.push(`health:${generation}`);
      return { generation, ready: health[generation] ?? true };
    },
    async restore({ generation, failedGeneration }) {
      calls.restore += 1;
      events.push(`effect:restore:${generation}`);
      assert.equal(state.activeGeneration, failedGeneration);
      const retained = new Set(state.retainedGenerations);
      assert.equal(retained.has(generation), true);
      retained.delete(generation);
      retained.add(failedGeneration);
      state.activeGeneration = generation;
      state.retainedGenerations = [...retained];
      state.running = false;
    },
  };

  return {
    ports,
    calls,
    events,
    state,
    journal: () => clone(journal),
    setFailObservationAt(value) { failObservationAt = value; },
    resetObservationCount() { observationCount = 0; },
    setFailJournalSaveWhen(value) { failJournalSaveWhen = value; },
  };
}

function assertIntentBeforeEffect(events, effect) {
  const effectIndex = events.findIndex((event) => event.startsWith(`effect:${effect}:`));
  assert.notEqual(effectIndex, -1, `missing ${effect} effect`);
  const plannedIndex = events.slice(0, effectIndex).findLastIndex((event) => event.includes(`:${effect}:planned:`));
  const attemptedIndex = events.slice(0, effectIndex).findLastIndex((event) => event.includes(`:${effect}:attempted:`));
  assert.notEqual(plannedIndex, -1, `missing durable ${effect} plan`);
  assert.notEqual(attemptedIndex, -1, `missing durable ${effect} attempt`);
  assert.ok(plannedIndex < attemptedIndex && attemptedIndex < effectIndex, `${effect} must be journaled before the external effect`);
}

test('fresh authority reconciliation journals exact intent before each effect and reaches one healthy generation', async () => {
  const values = fixture();
  const result = await reconcileProtectedAuthority({ candidate: { generation: A }, ports: values.ports });

  assert.equal(result.protocol, PROTECTED_AUTHORITY_RECONCILIATION_PROTOCOL);
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(result.generation, A);
  assert.equal(values.state.activeGeneration, A);
  assert.equal(values.state.running, true);
  assert.equal(values.journal().protocol, PROTECTED_AUTHORITY_RECONCILIATION_JOURNAL_PROTOCOL);
  assert.equal(values.journal().outcome, 'complete');
  assert.equal(values.calls.stage, 1);
  assert.equal(values.calls.quiesce, 0);
  assert.equal(values.calls.promote, 1);
  assert.equal(values.calls.start, 1);
  for (const effect of ['stage', 'promote', 'start']) assertIntentBeforeEffect(values.events, effect);
});

test('exact current healthy generation is a true privileged no-op with no journal churn', async () => {
  const values = fixture({ activeGeneration: A, running: true });
  const result = await reconcileProtectedAuthority({ candidate: { generation: A }, ports: values.ports });

  assert.equal(result.ready, true);
  assert.equal(result.changed, false);
  assert.equal(result.transactionId, null);
  assert.equal(values.journal(), null);
  assert.deepEqual(values.calls, { stage: 0, quiesce: 0, promote: 0, start: 0, restore: 0, verify: 0, health: 1 });
  assert.equal(values.events.some((event) => event.startsWith('effect:')), false);
});

test('historical retained generations remain inert during an exact later replacement', async () => {
  const values = fixture({ activeGeneration: A, running: true, retainedGenerations: [C] });
  const result = await reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports });

  assert.equal(result.ready, true);
  assert.equal(result.generation, B);
  assert.equal(values.state.activeGeneration, B);
  assert.equal(values.state.running, true);
  assert.deepEqual(values.state.retainedGenerations, [C, A]);
  assert.equal(values.journal().previousGeneration, A);
  assert.equal(values.journal().outcome, 'complete');
});

test('a changed candidate replaces only a proven pre-effect transaction', async () => {
  const values = fixture({ activeGeneration: A, running: true });
  values.setFailJournalSaveWhen((record) => record.pending?.effect === 'stage');
  await assert.rejects(
    reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports }),
    /injected journal interruption/u,
  );
  assert.equal(values.journal().candidateGeneration, B);
  assert.equal(values.journal().phase, 'observed');
  assert.equal(values.journal().pending, null);
  assert.equal(values.calls.stage, 0);

  values.setFailJournalSaveWhen(null);
  const result = await reconcileProtectedAuthority({ candidate: { generation: C }, ports: values.ports });
  assert.equal(result.ready, true);
  assert.equal(result.generation, C);
  assert.equal(values.journal().candidateGeneration, C);
  assert.equal(values.journal().outcome, 'complete');
});

test('restart observes a completed staged effect before replay and does not repeat it', async () => {
  const values = fixture({ failObservationAt: 2 });
  await assert.rejects(
    reconcileProtectedAuthority({ candidate: { generation: A }, ports: values.ports }),
    /injected observation interruption/u,
  );
  assert.equal(values.calls.stage, 1);
  assert.equal(values.journal().pending.effect, 'stage');
  assert.equal(values.journal().pending.status, 'attempted');
  assert.equal(values.state.stagedGeneration, A);

  values.setFailObservationAt(null);
  values.resetObservationCount();
  const resumed = await reconcileProtectedAuthority({ candidate: { generation: A }, ports: values.ports });
  assert.equal(resumed.ready, true);
  assert.equal(values.calls.stage, 1, 'completed stage must be reconciled by observation rather than replayed');
  assert.equal(values.calls.promote, 1);
  assert.equal(values.calls.start, 1);
});

test('failed replacement health restores and revalidates the exact previous generation', async () => {
  const values = fixture({ activeGeneration: A, running: true, health: { [A]: true, [B]: false } });
  const result = await reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports });

  assert.equal(result.ready, false);
  assert.equal(result.recovered, true);
  assert.equal(result.blocker, 'candidate-health');
  assert.equal(result.generation, A);
  assert.equal(values.state.activeGeneration, A);
  assert.equal(values.state.running, true);
  assert.equal(values.calls.stage, 1);
  assert.equal(values.calls.quiesce, 1);
  assert.equal(values.calls.promote, 1);
  assert.equal(values.calls.restore, 1);
  assert.equal(values.calls.start, 2);
  assert.equal(values.journal().outcome, 'rejected');
  assert.equal(values.journal().candidateGeneration, B);
  assert.equal(values.journal().previousGeneration, A);
});

test('completed restoration with a lost result resumes rejection recovery instead of restaging the candidate', async () => {
  const values = fixture({ activeGeneration: A, running: true, health: { [A]: true, [B]: false } });
  const restore = values.ports.restore;
  let interrupted = false;
  values.ports.restore = async (request) => {
    await restore(request);
    if (!interrupted) {
      interrupted = true;
      throw new Error('injected restoration result loss');
    }
  };

  await assert.rejects(
    reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports }),
    /restoration result loss/u,
  );
  assert.equal(values.state.activeGeneration, A);
  assert.equal(values.state.running, false);
  assert.equal(values.journal().pending.effect, 'restore');
  assert.equal(values.journal().reason, 'candidate-health');
  assert.equal(values.calls.restore, 1);
  assert.equal(values.calls.stage, 1);

  const resumed = await reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports });
  assert.equal(resumed.ready, false);
  assert.equal(resumed.recovered, true);
  assert.equal(resumed.generation, A);
  assert.equal(values.state.running, true);
  assert.equal(values.calls.restore, 1, 'observed restoration must not replay');
  assert.equal(values.calls.stage, 1, 'rejected candidate must not be restaged');
  assert.equal(values.journal().outcome, 'rejected');
  assert.equal(values.journal().reason, 'candidate-health');
});

test('durable rejection intent takes precedence when candidate health improves before interrupted restore resumes', async () => {
  const health = { [A]: true, [B]: false };
  const values = fixture({ activeGeneration: A, running: true, health });
  const restore = values.ports.restore;
  let interrupted = false;
  values.ports.restore = async (request) => {
    if (!interrupted) {
      interrupted = true;
      throw new Error('injected restoration interruption');
    }
    return await restore(request);
  };

  await assert.rejects(
    reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports }),
    /restoration interruption/u,
  );
  assert.equal(values.state.activeGeneration, B);
  assert.equal(values.state.running, true);
  assert.equal(values.journal().pending.effect, 'restore');
  assert.equal(values.journal().reason, 'candidate-health');

  health[B] = true;
  const resumed = await reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports });
  assert.equal(resumed.ready, false);
  assert.equal(resumed.recovered, true);
  assert.equal(resumed.generation, A);
  assert.equal(values.state.activeGeneration, A);
  assert.equal(values.state.running, true);
  assert.equal(values.calls.restore, 1);
  assert.equal(values.calls.stage, 1, 'durably rejected candidate must not be accepted or restaged');
  assert.equal(values.journal().outcome, 'rejected');
});

test('candidate drift is rejected while an interrupted exact transaction remains active', async () => {
  const values = fixture({ failObservationAt: 2 });
  await assert.rejects(reconcileProtectedAuthority({ candidate: { generation: A }, ports: values.ports }), /interruption/u);
  const effectsBefore = Object.values(values.calls).reduce((sum, value) => sum + value, 0);

  values.setFailObservationAt(null);
  values.resetObservationCount();
  await assert.rejects(
    reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports }),
    /candidate changed while reconciliation is active/u,
  );
  const effectsAfter = Object.values(values.calls).reduce((sum, value) => sum + value, 0);
  assert.equal(effectsAfter, effectsBefore, 'candidate drift must fail before another effect');
  assert.equal(values.journal().candidateGeneration, A);
});

test('unexpected state after an interrupted effect is checkpointed as ambiguous instead of replayed', async () => {
  const values = fixture({ failObservationAt: 2 });
  await assert.rejects(reconcileProtectedAuthority({ candidate: { generation: A }, ports: values.ports }), /interruption/u);
  assert.equal(values.calls.stage, 1);

  values.state.stagedGeneration = C;
  values.setFailObservationAt(null);
  values.resetObservationCount();
  await assert.rejects(
    reconcileProtectedAuthority({ candidate: { generation: A }, ports: values.ports }),
    /stage effect is ambiguous/u,
  );
  assert.equal(values.calls.stage, 1, 'ambiguous observation must never trigger a blind replay');
  assert.equal(values.journal().outcome, 'blocked');
  assert.equal(values.journal().reason, 'ambiguous-effect');
});

test('blocked recovery health fences a new candidate and reconciles only by read-only health plus journal', async () => {
  const health = { [A]: false, [B]: false };
  const values = fixture({ activeGeneration: A, running: true, health });
  await assert.rejects(
    reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports }),
    /previous generation failed recovery health/u,
  );
  const effectsBefore = Object.fromEntries(Object.entries(values.calls).filter(([name]) => ['stage', 'quiesce', 'promote', 'start', 'restore'].includes(name)));
  health[A] = true;
  const recovered = await reconcileProtectedAuthority({ candidate: { generation: C }, ports: values.ports });
  assert.equal(recovered.ready, false);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.generation, A);
  assert.equal(values.journal().outcome, 'rejected');
  assert.equal(values.journal().candidateGeneration, B);
  const effectsAfter = Object.fromEntries(Object.entries(values.calls).filter(([name]) => ['stage', 'quiesce', 'promote', 'start', 'restore'].includes(name)));
  assert.deepEqual(effectsAfter, effectsBefore);
});

test('resume refuses to complete a promoted generation after exact rollback evidence disappears', async () => {
  const values = fixture({ activeGeneration: A, running: true });
  values.setFailJournalSaveWhen((record) => record.outcome === 'complete');
  await assert.rejects(
    reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports }),
    /injected journal interruption/u,
  );

  assert.equal(values.state.activeGeneration, B);
  assert.equal(values.state.running, true);
  assert.deepEqual(values.state.retainedGenerations, [A]);
  assert.equal(values.journal().outcome, 'in-progress');
  assert.equal(values.journal().candidateGeneration, B);
  assert.equal(values.journal().previousGeneration, A);
  const effectsBefore = Object.fromEntries(Object.entries(values.calls).filter(([name]) => ['stage', 'quiesce', 'promote', 'start', 'restore'].includes(name)));

  values.state.retainedGenerations = [];
  values.setFailJournalSaveWhen(null);
  await assert.rejects(
    reconcileProtectedAuthority({ candidate: { generation: B }, ports: values.ports }),
    /did not retain the exact previous generation/u,
  );
  assert.equal(values.journal().outcome, 'blocked');
  assert.equal(values.journal().reason, 'ambiguous-effect');
  const effectsAfter = Object.fromEntries(Object.entries(values.calls).filter(([name]) => ['stage', 'quiesce', 'promote', 'start', 'restore'].includes(name)));
  assert.deepEqual(effectsAfter, effectsBefore, 'missing rollback evidence must block before another external effect');
});

test('shared reconciler rejects authority-shaped adapter data and contains no platform implementation identity', async () => {
  const values = fixture();
  values.ports.observe = async () => ({
    protocol: PROTECTED_AUTHORITY_OBSERVATION_PROTOCOL,
    ownership: 'absent',
    activeGeneration: null,
    stagedGeneration: null,
    running: false,
    retainedGenerations: [],
    command: 'forbidden',
  });
  await assert.rejects(
    reconcileProtectedAuthority({ candidate: { generation: A }, ports: values.ports }),
    /unknown field/u,
  );

  const file = fileURLToPath(new URL('../src/setup/protected-authority-reconciliation.js', import.meta.url));
  const source = await readFile(file, 'utf8');
  for (const forbidden of ['Windows', 'Linux', 'PowerShell', 'Hyper-V', 'libvirt', 'VHDX', 'qcow2', 'systemd', 'sudo', 'SCM', 'providerGroup', 'serviceName', 'filesystemPath']) {
    assert.equal(source.includes(forbidden), false, `shared reconciler must not contain ${forbidden}`);
  }
});
