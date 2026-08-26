import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createWindowsLifecycleAuthorityRefreshPorts,
  reconcileWindowsLifecycleAuthorityRefresh,
} from '../src/setup/windows-lifecycle-authority-refresh-adapter.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fixture({
  serviceGeneration = null,
  serviceRunning = false,
  preparedGeneration = null,
  retainedGenerations = [],
  health = {},
} = {}) {
  const state = {
    owner: serviceGeneration == null && preparedGeneration == null ? 'absent' : 'devbridge',
    serviceGeneration,
    preparedGeneration,
    serviceRunning,
    retainedGenerations: [...retainedGenerations],
  };
  let journal = null;
  const events = [];
  const calls = {
    materialize: 0,
    verify: 0,
    stop: 0,
    configure: 0,
    start: 0,
    probe: 0,
    restore: 0,
  };

  const mechanics = {
    journal: {
      async load() {
        events.push('journal:load');
        return clone(journal);
      },
      async save(value) {
        journal = clone(value);
        const pending = value.pending == null ? '-' : `${value.pending.effect}:${value.pending.status}`;
        events.push(`journal:save:${value.phase}:${pending}`);
      },
    },
    async readInstallation() {
      events.push('inspect');
      return clone(state);
    },
    async materializeGeneration({ generation }) {
      calls.materialize += 1;
      events.push(`materialize:${generation}`);
      state.owner = 'devbridge';
      state.preparedGeneration = generation;
    },
    async verifyGeneration({ generation }) {
      calls.verify += 1;
      events.push(`verify:${generation}`);
      return { generation, verified: true };
    },
    async stopServiceGeneration({ generation }) {
      calls.stop += 1;
      events.push(`stop:${generation}`);
      assert.equal(state.serviceGeneration, generation);
      state.serviceRunning = false;
    },
    async configureServiceGeneration({ generation, previousGeneration }) {
      calls.configure += 1;
      events.push(`configure:${generation}:${previousGeneration ?? 'absent'}`);
      assert.equal(state.preparedGeneration, generation);
      assert.equal(state.serviceGeneration, previousGeneration);
      if (previousGeneration != null && !state.retainedGenerations.includes(previousGeneration)) {
        state.retainedGenerations.push(previousGeneration);
      }
      state.owner = 'devbridge';
      state.serviceGeneration = generation;
      state.preparedGeneration = null;
      state.serviceRunning = false;
    },
    async startServiceGeneration({ generation }) {
      calls.start += 1;
      events.push(`start:${generation}`);
      assert.equal(state.serviceGeneration, generation);
      state.serviceRunning = true;
    },
    async probeServiceGeneration({ generation }) {
      calls.probe += 1;
      events.push(`probe:${generation}`);
      assert.equal(state.serviceGeneration, generation);
      return { generation, ready: health[generation] ?? true };
    },
    async restoreServiceGeneration({ generation, failedGeneration }) {
      calls.restore += 1;
      events.push(`restore:${generation}:${failedGeneration}`);
      assert.equal(state.serviceGeneration, failedGeneration);
      assert.equal(state.retainedGenerations.includes(generation), true);
      state.retainedGenerations = state.retainedGenerations.filter((entry) => entry !== generation);
      if (!state.retainedGenerations.includes(failedGeneration)) state.retainedGenerations.push(failedGeneration);
      state.serviceGeneration = generation;
      state.serviceRunning = false;
    },
  };

  return { mechanics, state, calls, events, journal: () => clone(journal) };
}

test('Windows refresh adapter drives fresh materialization through the shared reconciliation LEGO', async () => {
  const values = fixture();
  const diagnostics = [];
  const result = await reconcileWindowsLifecycleAuthorityRefresh({ candidateGeneration: A, mechanics: values.mechanics, onDiagnostic: (event) => diagnostics.push(event) });

  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(result.generation, A);
  assert.equal(values.state.serviceGeneration, A);
  assert.equal(values.state.serviceRunning, true);
  assert.deepEqual(values.calls, {
    materialize: 1,
    verify: 1,
    stop: 0,
    configure: 1,
    start: 1,
    probe: 1,
    restore: 0,
  });
  assert.equal(values.journal().outcome, 'complete');
  assert.ok(values.events.indexOf(`materialize:${A}`) < values.events.indexOf(`configure:${A}:absent`));
  assert.deepEqual(diagnostics.map((event) => [event.phase, event.state]).filter(([phase]) => ['refresh-stage', 'refresh-verify', 'refresh-promote', 'refresh-start', 'refresh-health'].includes(phase)), [
    ['refresh-stage', 'attempted'], ['refresh-stage', 'completed'],
    ['refresh-verify', 'attempted'], ['refresh-verify', 'completed'],
    ['refresh-promote', 'attempted'], ['refresh-promote', 'completed'],
    ['refresh-start', 'attempted'], ['refresh-start', 'completed'],
    ['refresh-health', 'attempted'], ['refresh-health', 'completed'],
  ]);
  assert.equal(diagnostics.at(0).phase, 'refresh');
  assert.equal(diagnostics.at(-1).state, 'completed');
});

test('Windows refresh diagnostics preserve the first exact failing port and stop before later effects', async () => {
  const values = fixture();
  const diagnostics = [];
  values.mechanics.materializeGeneration = async () => { throw new Error('exact materialization failure'); };
  await assert.rejects(() => reconcileWindowsLifecycleAuthorityRefresh({
    candidateGeneration: A,
    mechanics: values.mechanics,
    onDiagnostic: (event) => diagnostics.push(event),
  }), /exact materialization failure/u);
  assert.ok(diagnostics.some((event) => event.phase === 'refresh-stage' && event.state === 'failed' && event.detail.error === 'exact materialization failure'));
  assert.ok(diagnostics.some((event) => event.phase === 'refresh' && event.state === 'failed' && event.detail.error === 'exact materialization failure'));
  assert.equal(diagnostics.some((event) => ['refresh-promote', 'refresh-start', 'refresh-health'].includes(event.phase)), false);
});

test('Windows refresh adapter preserves exact previous generation and restores it after failed candidate health', async () => {
  const values = fixture({ serviceGeneration: A, serviceRunning: true, health: { [A]: true, [B]: false } });
  const result = await reconcileWindowsLifecycleAuthorityRefresh({ candidateGeneration: B, mechanics: values.mechanics });

  assert.equal(result.ready, false);
  assert.equal(result.recovered, true);
  assert.equal(result.blocker, 'candidate-health');
  assert.equal(result.generation, A);
  assert.equal(values.state.serviceGeneration, A);
  assert.equal(values.state.serviceRunning, true);
  assert.deepEqual(values.state.retainedGenerations, [B]);
  assert.deepEqual(values.calls, {
    materialize: 1,
    verify: 2,
    stop: 1,
    configure: 1,
    start: 2,
    probe: 2,
    restore: 1,
  });
  assert.equal(values.journal().outcome, 'rejected');
});

test('exact current Windows generation is a true mutation-free adapter no-op', async () => {
  const values = fixture({ serviceGeneration: A, serviceRunning: true });
  const result = await reconcileWindowsLifecycleAuthorityRefresh({ candidateGeneration: A, mechanics: values.mechanics });

  assert.equal(result.ready, true);
  assert.equal(result.changed, false);
  assert.equal(result.transactionId, null);
  assert.deepEqual(values.calls, {
    materialize: 0,
    verify: 0,
    stop: 0,
    configure: 0,
    start: 0,
    probe: 1,
    restore: 0,
  });
  assert.equal(values.journal(), null);
});

test('adapter rejects generic authority mechanics and topology-shaped inspection data before effects', async () => {
  const values = fixture();
  await assert.rejects(
    () => reconcileWindowsLifecycleAuthorityRefresh({
      candidateGeneration: A,
      mechanics: { ...values.mechanics, commandRunner: async () => {} },
    }),
    /mechanics contains an unknown field/u,
  );
  assert.deepEqual(values.calls, {
    materialize: 0,
    verify: 0,
    stop: 0,
    configure: 0,
    start: 0,
    probe: 0,
    restore: 0,
  });

  const malformed = fixture();
  malformed.mechanics.readInstallation = async () => ({
    ...clone(malformed.state),
    path: 'C:\\sensitive\\authority',
  });
  const ports = createWindowsLifecycleAuthorityRefreshPorts({ mechanics: malformed.mechanics });
  await assert.rejects(() => ports.observe(), /inspection contains an unknown field/u);
});

test('Windows refresh adapter contains no SCM, shell, filesystem-path, or provider implementation authority', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/windows-lifecycle-authority-refresh-adapter.js', import.meta.url)), 'utf8');
  for (const forbidden of ['sc.exe', 'powershell.exe', 'Hyper-V', 'libvirt', 'provider', 'executable:', 'arguments:', 'commandRunner']) {
    assert.equal(source.includes(forbidden), false, `refresh adapter gained implementation authority through ${forbidden}`);
  }
});
