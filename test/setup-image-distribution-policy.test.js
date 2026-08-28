import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileSetupImageDistributionPolicy } from '../src/app/setup-image-distribution-policy.js';
import { reconcileSetupProfileSelection } from '../src/app/setup-profile-selection.js';
import { SetupAuthorityManager } from '../src/runtime/setup-authority.js';
import { createSetupAuthorityStateStore } from '../src/state/setup-authority-state-store.js';

const PROFILE = 'windows-development';

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

async function selectedState() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-distribution-policy-'));
  const stateDirectory = path.join(root, 'state');
  await reconcileSetupProfileSelection({ stateDirectory, choice: 'windows' });
  return { root, stateDirectory };
}

test('explicit local reconstruction selection is accepted once and re-observed after restart', async () => {
  const fixture = await selectedState();
  try {
    assert.deepEqual(await reconcileSetupImageDistributionPolicy({ stateDirectory: fixture.stateDirectory, profile: PROFILE }), {
      protocol: 'devbridge/setup-image-distribution-policy-status-v1',
      state: 'selection-required',
      ready: false,
      changed: false,
      mode: null,
      blocker: 'Image distribution policy requires an explicit local selection',
    });
    const accepted = await reconcileSetupImageDistributionPolicy({
      stateDirectory: fixture.stateDirectory,
      profile: PROFILE,
      choice: 'local-reconstruction',
    });
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.changed, true);
    assert.equal(accepted.mode, 'local-reconstruction');
    assert.equal(Object.hasOwn(accepted, 'subject'), false);
    const restarted = await reconcileSetupImageDistributionPolicy({ stateDirectory: fixture.stateDirectory, profile: PROFILE });
    assert.equal(restarted.state, 'accepted');
    assert.equal(restarted.changed, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('interrupted profile-owned selection resumes without repeating the operator choice', async () => {
  const fixture = await selectedState();
  const memory = memoryPolicyStore();
  let fail = true;
  const storeFactory = () => ({
    load: memory.port.load,
    async save(subject, value) {
      if (fail) { fail = false; throw new Error('simulated publication interruption'); }
      return memory.port.save(subject, value);
    },
  });
  try {
    await assert.rejects(() => reconcileSetupImageDistributionPolicy({
      stateDirectory: fixture.stateDirectory,
      profile: PROFILE,
      choice: 'local-reconstruction',
    }, { storeFactory }), /simulated publication interruption/u);
    const profile = await reconcileSetupProfileSelection({ stateDirectory: fixture.stateDirectory });
    assert.equal(profile.state, 'accepted');
    const resumed = await reconcileSetupImageDistributionPolicy({
      stateDirectory: fixture.stateDirectory,
      profile: PROFILE,
    }, { storeFactory });
    assert.equal(resumed.state, 'accepted');
    assert.equal(resumed.changed, true);
    const record = await new SetupAuthorityManager({
      port: createSetupAuthorityStateStore(path.join(fixture.stateDirectory, 'setup-authority.json')),
    }).current();
    assert.equal(record.working, null);
    assert.equal(record.accepted.authorities.find((entry) => entry.class === 'distribution').availability, 'available');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('accepted authority fails closed when its immutable policy is missing or substituted', async () => {
  for (const substitution of [null, { protocol: 'devbridge/image-distribution-policy-v1', mode: 'local-reconstruction', repository: 'unexpected' }]) {
    const fixture = await selectedState();
    const memory = memoryPolicyStore();
    try {
      await reconcileSetupImageDistributionPolicy({ stateDirectory: fixture.stateDirectory, profile: PROFILE, choice: 'local-reconstruction' }, {
        storeFactory: () => memory.port,
      });
      const [subject] = memory.values.keys();
      if (substitution == null) memory.values.delete(subject);
      else memory.values.set(subject, substitution);
      const observed = await reconcileSetupImageDistributionPolicy({ stateDirectory: fixture.stateDirectory, profile: PROFILE }, {
        storeFactory: () => memory.port,
      });
      assert.equal(observed.state, 'blocked');
      assert.equal(observed.ready, false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('another profile or setup component transaction is observed but never consumed', async () => {
  const fixture = await selectedState();
  try {
    const manager = new SetupAuthorityManager({
      port: createSetupAuthorityStateStore(path.join(fixture.stateDirectory, 'setup-authority.json')),
      id: () => 'foreign-setup-operation',
    });
    await manager.begin();
    const observed = await reconcileSetupImageDistributionPolicy({ stateDirectory: fixture.stateDirectory, profile: PROFILE });
    assert.equal(observed.state, 'selection-required');
    assert.equal((await manager.current()).working.operationId, 'foreign-setup-operation');
    await assert.rejects(() => reconcileSetupImageDistributionPolicy({
      stateDirectory: fixture.stateDirectory,
      profile: PROFILE,
      choice: 'local-reconstruction',
    }), /owned by another setup component/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('one profile cannot absorb another profile owned distribution transaction', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-distribution-profile-owner-'));
  const stateDirectory = path.join(root, 'state');
  const memory = memoryPolicyStore();
  let fail = true;
  const storeFactory = () => ({
    load: memory.port.load,
    async save(subject, value) {
      if (fail) { fail = false; throw new Error('simulated profile publication interruption'); }
      return memory.port.save(subject, value);
    },
  });
  try {
    await reconcileSetupProfileSelection({ stateDirectory, choice: 'both' });
    await assert.rejects(() => reconcileSetupImageDistributionPolicy({
      stateDirectory,
      profile: 'linux-development',
      choice: 'local-reconstruction',
    }, { storeFactory }), /simulated profile publication interruption/u);

    const windows = await reconcileSetupImageDistributionPolicy({
      stateDirectory,
      profile: PROFILE,
    }, { storeFactory });
    assert.equal(windows.state, 'selection-required');
    await assert.rejects(() => reconcileSetupImageDistributionPolicy({
      stateDirectory,
      profile: PROFILE,
      choice: 'local-reconstruction',
    }, { storeFactory }), /owned by another setup component/u);

    const linux = await reconcileSetupImageDistributionPolicy({
      stateDirectory,
      profile: 'linux-development',
    }, { storeFactory });
    assert.equal(linux.state, 'accepted');
    assert.equal((await new SetupAuthorityManager({
      port: createSetupAuthorityStateStore(path.join(stateDirectory, 'setup-authority.json')),
    }).current()).working, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile identity is local data and cannot select an absent authority row', async () => {
  const fixture = await selectedState();
  try {
    await assert.rejects(() => reconcileSetupImageDistributionPolicy({
      stateDirectory: fixture.stateDirectory,
      profile: 'linux-development',
      choice: 'local-reconstruction',
    }), /does not contain the required profile/u);
    await assert.rejects(() => reconcileSetupImageDistributionPolicy({
      stateDirectory: fixture.stateDirectory,
      profile: '../escape',
    }), /profile is invalid/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
