import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileSetupProfileSelection } from '../src/app/setup-profile-selection.js';
import { reconcileSetupWindowsActivationPolicy } from '../src/app/setup-windows-activation-policy.js';
import { SetupAuthorityManager } from '../src/runtime/setup-authority.js';
import { createSetupAuthorityStateStore } from '../src/state/setup-authority-state-store.js';

function memoryPolicyStore() {
  const values = new Map();
  return {
    values,
    port: {
      async load(subject) { return structuredClone(values.get(subject)); },
      async save(subject, value) {
        const current = values.get(subject);
        if (current != null && JSON.stringify(current) !== JSON.stringify(value)) throw new Error('immutable record changed');
        values.set(subject, structuredClone(value));
        return { changed: current == null };
      },
    },
  };
}

async function selectedWindowsState() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-activation-policy-'));
  const stateDirectory = path.join(root, 'state');
  await reconcileSetupProfileSelection({ stateDirectory, choice: 'windows' });
  return { root, stateDirectory };
}

test('explicit configure-later selection is accepted once and re-observed after restart', async () => {
  const fixture = await selectedWindowsState();
  try {
    const initial = await reconcileSetupWindowsActivationPolicy({ stateDirectory: fixture.stateDirectory });
    assert.deepEqual(initial, {
      protocol: 'devbridge/setup-windows-activation-policy-status-v1',
      state: 'selection-required',
      ready: false,
      changed: false,
      mode: null,
      activationRequired: true,
      blocker: 'Windows activation policy requires an explicit local selection',
    });
    const accepted = await reconcileSetupWindowsActivationPolicy({ stateDirectory: fixture.stateDirectory, choice: 'later' });
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.changed, true);
    assert.equal(accepted.mode, 'configure-later');
    assert.equal(accepted.activationRequired, true);
    assert.equal(Object.hasOwn(accepted, 'subject'), false);
    const restarted = await reconcileSetupWindowsActivationPolicy({ stateDirectory: fixture.stateDirectory });
    assert.equal(restarted.state, 'accepted');
    assert.equal(restarted.changed, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('interrupted component-owned selection resumes without repeating the operator choice', async () => {
  const fixture = await selectedWindowsState();
  const memory = memoryPolicyStore();
  let fail = true;
  const storeFactory = () => ({
    load: memory.port.load,
    async save(subject, value) {
      if (fail) {
        fail = false;
        throw new Error('simulated publication interruption');
      }
      return memory.port.save(subject, value);
    },
  });
  try {
    await assert.rejects(() => reconcileSetupWindowsActivationPolicy({
      stateDirectory: fixture.stateDirectory,
      choice: 'later',
    }, { storeFactory }), /simulated publication interruption/u);
    const resumed = await reconcileSetupWindowsActivationPolicy({ stateDirectory: fixture.stateDirectory }, { storeFactory });
    assert.equal(resumed.state, 'accepted');
    assert.equal(resumed.changed, true);
    const record = await new SetupAuthorityManager({
      port: createSetupAuthorityStateStore(path.join(fixture.stateDirectory, 'setup-authority.json')),
    }).current();
    assert.equal(record.working, null);
    assert.equal(record.accepted.authorities.find((entry) => entry.class === 'activation').availability, 'available');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('accepted authority fails closed when its immutable policy is missing or substituted', async () => {
  for (const substitution of [null, { protocol: 'devbridge/windows-activation-policy-v1', mode: 'configure-later', credential: 'unexpected' }]) {
    const fixture = await selectedWindowsState();
    const memory = memoryPolicyStore();
    try {
      await reconcileSetupWindowsActivationPolicy({ stateDirectory: fixture.stateDirectory, choice: 'later' }, {
        storeFactory: () => memory.port,
      });
      const [subject] = memory.values.keys();
      if (substitution == null) memory.values.delete(subject);
      else memory.values.set(subject, substitution);
      const observed = await reconcileSetupWindowsActivationPolicy({ stateDirectory: fixture.stateDirectory }, {
        storeFactory: () => memory.port,
      });
      assert.equal(observed.state, 'blocked');
      assert.equal(observed.ready, false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('foreign setup-authority work is never consumed by activation-policy selection', async () => {
  const fixture = await selectedWindowsState();
  try {
    const manager = new SetupAuthorityManager({
      port: createSetupAuthorityStateStore(path.join(fixture.stateDirectory, 'setup-authority.json')),
      id: () => 'foreign-setup-operation',
    });
    await manager.begin();
    await assert.rejects(() => reconcileSetupWindowsActivationPolicy({
      stateDirectory: fixture.stateDirectory,
      choice: 'later',
    }), /owned by another setup component/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
