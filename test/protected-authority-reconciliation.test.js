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
