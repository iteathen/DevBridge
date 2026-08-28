import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createLinuxLifecycleAuthorityRefreshMechanics,
} from '../src/setup/linux-lifecycle-authority-refresh-mechanics.js';
import {
  reconcileLinuxLifecycleAuthorityRefresh,
} from '../src/setup/linux-lifecycle-authority-refresh-adapter.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function fixture({
  candidateGeneration = B,
  activeGeneration = null,
  running = false,
  retainedGenerations = [],
  health = {},
} = {}) {
  let journal = null;
  let state = {
    bound: true,
    activeGeneration,
    stagedGeneration: null,
    retainedGenerations: [...retainedGenerations],
  };
  const subjects = new Set([activeGeneration, ...retainedGenerations].filter(Boolean));
  const activity = {
    exists: activeGeneration != null,
    running,
    configuredGeneration: activeGeneration,
    processGeneration: running ? activeGeneration : null,
  };
  const calls = {
    stage: 0,
    verify: 0,
    prepare: 0,
    define: 0,
    quiesce: 0,
    activate: 0,
    probe: 0,
    stateSave: 0,
  };
  const failures = new Map();
  const verificationFailures = new Map();

  function failAfter(name, count = 1) {
    failures.set(name, count);
  }

  function interrupt(name) {
    const remaining = failures.get(name) ?? 0;
    if (remaining < 1) return;
    if (remaining > 1) {
      failures.set(name, remaining - 1);
      return;
    }
    failures.delete(name);
    throw new Error(`${name} interrupted after effect`);
  }

  function rejectVerificationAfter(generation, count = 1) {
    verificationFailures.set(generation, count);
  }

  function clone(value) {
    return value == null ? null : structuredClone(value);
  }

  const ports = {
    journal: {
      async load() { return clone(journal); },
      async save(value) { journal = clone(value); },
    },
    transition: {
      async load() {
        if (journal?.outcome !== 'in-progress' || journal.pending == null) return null;
        return {
          effect: journal.pending.effect,
          targetGeneration: journal.pending.targetGeneration,
          candidateGeneration: journal.candidateGeneration,
          previousGeneration: journal.previousGeneration,
          status: journal.pending.status,
        };
      },
    },
    state: {
      async load() { return clone(state); },
      async save(value) {
        calls.stateSave += 1;
        const prior = state;
        state = clone(value);
        if (prior?.activeGeneration !== state.activeGeneration) interrupt('active-state');
        if (prior?.stagedGeneration !== state.stagedGeneration && state.stagedGeneration != null) interrupt('staged-state');
        return clone(state);
      },
    },
    subjects: {
      async observe({ generations }) {
        return {
          presentGenerations: [...subjects].filter((entry) => generations.includes(entry)).sort(),
          exact: [...subjects].every((entry) => generations.includes(entry)),
        };
      },
      async stage({ generation }) {
        calls.stage += 1;
        subjects.add(generation);
        interrupt('stage');
        return { generation, ready: true };
      },
      async verify({ generation }) {
        calls.verify += 1;
        const remaining = verificationFailures.get(generation) ?? 0;
        if (remaining > 1) verificationFailures.set(generation, remaining - 1);
        else if (remaining === 1) verificationFailures.delete(generation);
        return { generation, verified: subjects.has(generation) && remaining !== 1 };
      },
    },
    preparation: {
      async ensure({ generation }) {
        calls.prepare += 1;
        interrupt('preparation');
        return { generation, ready: true };
      },
    },
    definition: {
      async ensure({ generation, acceptedGenerations }) {
        calls.define += 1;
        if (activity.exists && activity.configuredGeneration !== generation
            && !acceptedGenerations.includes(activity.configuredGeneration)) {
          throw new Error('fake definition rejected unadmitted current generation');
        }
        activity.exists = true;
        activity.running = false;
        activity.configuredGeneration = generation;
        activity.processGeneration = null;
        interrupt('definition');
        return { generation, ready: true };
      },
    },
    activity: {
      async inspect() { return clone(activity); },
      async quiesce({ generation }) {
        calls.quiesce += 1;
        assert.equal(activity.configuredGeneration, generation);
        activity.running = false;
        activity.processGeneration = null;
        interrupt('quiesce');
        return { generation, ready: true };
      },
      async activate({ generation }) {
        calls.activate += 1;
        assert.equal(activity.configuredGeneration, generation);
        activity.running = true;
        activity.processGeneration = generation;
        interrupt('activate');
        return { generation, ready: true };
      },
    },
    async probe({ generation }) {
      calls.probe += 1;
      const ready = health[generation] ?? true;
      return { generation, ready, reason: ready ? null : 'bounded health failure' };
    },
  };

  function mechanics() {
    return createLinuxLifecycleAuthorityRefreshMechanics({ candidateGeneration, ports });
  }

  async function reconcile() {
    return await reconcileLinuxLifecycleAuthorityRefresh({ candidateGeneration, mechanics: mechanics() });
  }

  return {
    activity,
    calls,
    failAfter,
    failures,
    get journal() { return clone(journal); },
    mechanics,
    ports,
    reconcile,
    rejectVerificationAfter,
    setActivity(value) { Object.assign(activity, value); },
    setState(value) { state = value == null ? null : clone(value); },
    get state() { return clone(state); },
    subjects,
  };
}

function mutationCounts(value) {
  return {
    stage: value.stage,
    prepare: value.prepare,
    define: value.define,
    quiesce: value.quiesce,
    activate: value.activate,
    stateSave: value.stateSave,
  };
}

test('fresh refresh activates one exact candidate and exact-current re-entry is mutation-free', async () => {
  const values = fixture();
  const first = await values.reconcile();
  assert.equal(first.ready, true);
  assert.equal(first.changed, true);
  assert.deepEqual(values.state, {
    bound: true,
    activeGeneration: B,
    stagedGeneration: null,
    retainedGenerations: [],
  });
  assert.deepEqual(values.activity, {
    exists: true,
    running: true,
    configuredGeneration: B,
    processGeneration: B,
  });
  const before = mutationCounts(values.calls);
  const second = await values.reconcile();
  assert.equal(second.ready, true);
  assert.equal(second.changed, false);
  assert.deepEqual(mutationCounts(values.calls), before);
});

test('stale refresh retains the prior generation and failed candidate health restores it exactly', async () => {
  const success = fixture({ activeGeneration: A, running: true });
  const promoted = await success.reconcile();
  assert.equal(promoted.ready, true);
  assert.deepEqual(success.state, {
    bound: true,
    activeGeneration: B,
    stagedGeneration: null,
    retainedGenerations: [A],
  });
  assert.equal(success.calls.quiesce, 1);
  assert.equal(success.calls.define, 1);

  const recovery = fixture({ activeGeneration: A, running: true, health: { [B]: false, [A]: true } });
  const rejected = await recovery.reconcile();
  assert.equal(rejected.ready, false);
  assert.equal(rejected.recovered, true);
  assert.equal(rejected.generation, A);
  assert.deepEqual(recovery.state, {
    bound: true,
    activeGeneration: A,
    stagedGeneration: null,
    retainedGenerations: [B],
  });
  assert.equal(recovery.activity.running, true);
  assert.equal(recovery.activity.configuredGeneration, A);
  assert.equal(recovery.calls.define, 2);
  assert.equal(recovery.calls.quiesce, 2);
});

test('materialization committed before interruption is observed and exact stage state is replayed', async () => {
  const values = fixture();
  values.failAfter('stage');
  await assert.rejects(values.reconcile(), /stage interrupted/u);
  assert.equal(values.subjects.has(B), true);
  assert.equal(values.state.stagedGeneration, null);
  assert.equal(values.journal.pending.effect, 'stage');
  const resumed = await values.reconcile();
  assert.equal(resumed.ready, true);
  assert.equal(values.calls.stage, 2);
  assert.equal(values.state.activeGeneration, B);
});

test('definition publication without state checkpoint is an admitted pending promotion and replays locally', async () => {
  const values = fixture({ activeGeneration: A, running: true });
  values.failAfter('definition');
  await assert.rejects(values.reconcile(), /definition interrupted/u);
  assert.equal(values.state.activeGeneration, A);
  assert.equal(values.state.stagedGeneration, B);
  assert.equal(values.activity.configuredGeneration, B);
  assert.equal(values.activity.running, false);
  assert.equal(values.journal.pending.effect, 'promote');
  const resumed = await values.reconcile();
  assert.equal(resumed.ready, true);
  assert.equal(values.calls.define, 2);
  assert.equal(values.state.activeGeneration, B);
});

test('durable promotion completed before its result was lost is checkpointed without replay', async () => {
  const values = fixture({ activeGeneration: A, running: true });
  values.failAfter('active-state');
  await assert.rejects(values.reconcile(), /active-state interrupted/u);
  assert.equal(values.state.activeGeneration, B);
  assert.equal(values.activity.configuredGeneration, B);
  assert.equal(values.journal.pending.effect, 'promote');
  const before = values.calls.define;
  const resumed = await values.reconcile();
  assert.equal(resumed.ready, true);
  assert.equal(values.calls.define, before);
  assert.equal(values.calls.activate, 1);
});

test('completed quiesce and activation effects are observed rather than replayed', async () => {
  const quiesce = fixture({ activeGeneration: A, running: true });
  quiesce.failAfter('quiesce');
  await assert.rejects(quiesce.reconcile(), /quiesce interrupted/u);
  assert.equal(quiesce.activity.running, false);
  assert.equal((await quiesce.reconcile()).ready, true);
  assert.equal(quiesce.calls.quiesce, 1);

  const activate = fixture();
  activate.failAfter('activate');
  await assert.rejects(activate.reconcile(), /activate interrupted/u);
  assert.equal(activate.activity.running, true);
  assert.equal((await activate.reconcile()).ready, true);
  assert.equal(activate.calls.activate, 1);
});

test('restoration definition interruption resumes only the exact retained subject', async () => {
  const values = fixture({ activeGeneration: A, running: true, health: { [B]: false, [A]: true } });
  values.failAfter('definition', 2);
  await assert.rejects(values.reconcile(), /definition interrupted/u);
  assert.equal(values.journal.pending.effect, 'restore');
  assert.equal(values.state.activeGeneration, B);
  assert.deepEqual(values.state.retainedGenerations, [A]);
  assert.equal(values.activity.configuredGeneration, A);
  assert.equal(values.activity.running, false);
  const resumed = await values.reconcile();
  assert.equal(resumed.ready, false);
  assert.equal(resumed.recovered, true);
  assert.equal(values.state.activeGeneration, A);
  assert.deepEqual(values.state.retainedGenerations, [B]);
});

test('unjournaled configuration drift, missing subjects, and unbound state fail closed', async () => {
  const drift = fixture({ candidateGeneration: A, activeGeneration: A, running: false });
  drift.subjects.add(B);
  drift.setActivity({ exists: true, running: false, configuredGeneration: B, processGeneration: null });
  await assert.rejects(drift.reconcile(), /configured generation is undeclared|ownership is not exact/u);

  const missing = fixture({ candidateGeneration: A, activeGeneration: A, retainedGenerations: [B] });
  missing.subjects.delete(B);
  await assert.rejects(missing.reconcile(), /ownership is not exact/u);

  const unbound = fixture();
  unbound.setState({ bound: false, activeGeneration: null, stagedGeneration: null, retainedGenerations: [] });
  await assert.rejects(unbound.reconcile(), /ownership is not exact/u);
  assert.equal(unbound.calls.stage, 0);
});

test('retained capacity exhaustion blocks before materialization or activity mutation', async () => {
  const retainedGenerations = Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(64, '0'));
  const values = fixture({ activeGeneration: A, running: true, retainedGenerations });
  await assert.rejects(values.reconcile(), /retained generation capacity is exhausted/u);
  assert.equal(values.calls.stage, 0);
  assert.equal(values.calls.quiesce, 0);
  assert.equal(values.calls.prepare, 0);
  assert.equal(values.calls.define, 0);
  assert.equal(values.state.activeGeneration, A);
  assert.equal(values.activity.running, true);
});

test('damaged candidate and widened local contracts are rejected without authority expansion', async () => {
  const damaged = fixture();
  damaged.rejectVerificationAfter(B, 2);
  const rejected = await damaged.reconcile();
  assert.equal(rejected.ready, false);
  assert.equal(rejected.blocker, 'candidate-verification');
  assert.equal(damaged.calls.define, 0);
  assert.equal(damaged.calls.activate, 0);

  const values = fixture();
  assert.throws(() => createLinuxLifecycleAuthorityRefreshMechanics({
    candidateGeneration: B,
    ports: { ...values.ports, cleanup: async () => {} },
  }), /unknown field/u);
  const mechanics = values.mechanics();
  values.ports.activity.inspect = async () => ({ ...values.activity, source: 'foreign' });
  await assert.rejects(mechanics.observeInstallation(), /unknown field/u);

  const transition = fixture();
  transition.ports.transition.load = async () => ({
    effect: 'promote',
    targetGeneration: C,
    candidateGeneration: C,
    previousGeneration: null,
    status: 'attempted',
  });
  await assert.rejects(transition.mechanics().observeInstallation(), /does not match the exact candidate/u);
});

test('mechanic implementation remains isolated from connected topology and command authority', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-lifecycle-authority-refresh-mechanics.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /^import\s/mu);
  for (const forbidden of [
    'systemctl',
    'systemd',
    'libvirt',
    'qemu',
    'protected-tree',
    'protected-storage',
    'service-manager',
    'endpoint-topology',
    'executable:',
    'arguments:',
    'commandRunner',
  ]) assert.equal(source.includes(forbidden), false, `mechanic retained foreign topology through ${forbidden}`);
});
