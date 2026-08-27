import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  reconcileProtectedAuthorityRefresh,
} from '../src/setup/protected-authority-refresh-adapter.js';
import {
  reconcileLinuxLifecycleAuthorityRefresh,
} from '../src/setup/linux-lifecycle-authority-refresh-adapter.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function fixture({ activeGeneration = null, running = false, health = {} } = {}) {
  const state = {
    ownership: activeGeneration == null ? 'absent' : 'owned',
    activeGeneration,
    stagedGeneration: null,
    running,
    retainedGenerations: [],
  };
  let journal = null;
  const calls = { stage: 0, verify: 0, quiesce: 0, promote: 0, start: 0, probe: 0, restore: 0 };
  const mechanics = {
    journal: {
      async load() { return structuredClone(journal); },
      async save(value) { journal = structuredClone(value); },
    },
    async observeInstallation() { return structuredClone(state); },
    async stageGeneration({ generation }) {
      calls.stage += 1;
      state.ownership = 'owned';
      state.stagedGeneration = generation;
    },
    async verifyGeneration({ generation }) {
      calls.verify += 1;
      return { generation, verified: true };
    },
    async quiesceGeneration({ generation }) {
      calls.quiesce += 1;
      assert.equal(state.activeGeneration, generation);
      state.running = false;
    },
    async promoteGeneration({ generation, previousGeneration }) {
      calls.promote += 1;
      assert.equal(state.stagedGeneration, generation);
      assert.equal(state.activeGeneration, previousGeneration);
      if (previousGeneration != null) state.retainedGenerations.push(previousGeneration);
      state.activeGeneration = generation;
      state.stagedGeneration = null;
      state.running = false;
    },
    async startGeneration({ generation }) {
      calls.start += 1;
      assert.equal(state.activeGeneration, generation);
      state.running = true;
    },
    async probeGeneration({ generation }) {
      calls.probe += 1;
      assert.equal(state.activeGeneration, generation);
      const ready = health[generation] ?? true;
      return { generation, ready, reason: ready ? null : 'bounded health failure' };
    },
    async restoreGeneration({ generation, failedGeneration }) {
      calls.restore += 1;
      assert.equal(state.activeGeneration, failedGeneration);
      state.retainedGenerations = state.retainedGenerations.filter((entry) => entry !== generation);
      state.retainedGenerations.push(failedGeneration);
      state.activeGeneration = generation;
      state.running = false;
    },
  };
  return { state, calls, mechanics };
}

test('neutral refresh adapter performs one fresh transaction and then a mutation-free no-op', async () => {
  const values = fixture();
  const first = await reconcileProtectedAuthorityRefresh({ candidateGeneration: A, mechanics: values.mechanics });
  const second = await reconcileProtectedAuthorityRefresh({ candidateGeneration: A, mechanics: values.mechanics });
  assert.equal(first.ready, true);
  assert.equal(first.changed, true);
  assert.equal(second.ready, true);
  assert.equal(second.changed, false);
  assert.deepEqual(values.calls, { stage: 1, verify: 1, quiesce: 0, promote: 1, start: 1, probe: 2, restore: 0 });
});

test('neutral refresh adapter restores the exact prior generation after candidate health rejection', async () => {
  const values = fixture({ activeGeneration: A, running: true, health: { [A]: true, [B]: false } });
  const result = await reconcileProtectedAuthorityRefresh({ candidateGeneration: B, mechanics: values.mechanics });
  assert.equal(result.ready, false);
  assert.equal(result.recovered, true);
  assert.equal(result.generation, A);
  assert.equal(values.state.activeGeneration, A);
  assert.equal(values.state.running, true);
  assert.deepEqual(values.state.retainedGenerations, [B]);
});

test('Linux facade attaches only a neutral mechanic contract and projects its own diagnostic identity', async () => {
  const values = fixture();
  const diagnostics = [];
  const result = await reconcileLinuxLifecycleAuthorityRefresh({
    candidateGeneration: A,
    mechanics: values.mechanics,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  assert.equal(result.ready, true);
  assert.equal(diagnostics.length > 0, true);
  assert.equal(diagnostics.every((event) => event.protocol === 'devbridge/linux-lifecycle-authority-migration-diagnostic-v1'), true);
});

test('neutral refresh brick and Linux facade contain no foreign topology or process authority', async () => {
  const neutral = await readFile(fileURLToPath(new URL('../src/setup/protected-authority-refresh-adapter.js', import.meta.url)), 'utf8');
  const linux = await readFile(fileURLToPath(new URL('../src/setup/linux-lifecycle-authority-refresh-adapter.js', import.meta.url)), 'utf8');
  for (const forbidden of ['Windows', 'Linux', 'systemd', 'SCM', 'Hyper-V', 'libvirt', 'executable:', 'arguments:', 'commandRunner']) {
    assert.equal(neutral.includes(forbidden), false, `neutral refresh brick gained foreign authority through ${forbidden}`);
  }
  for (const forbidden of ['systemctl', 'libvirt', 'qemu', 'executable:', 'arguments:', 'commandRunner']) {
    assert.equal(linux.includes(forbidden), false, `Linux facade gained topology authority through ${forbidden}`);
  }
  assert.match(linux, /reconcileProtectedAuthorityRefresh/u);
});
