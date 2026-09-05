import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileSetupProfileSelection } from '../src/app/setup-profile-selection.js';
import { SetupAuthorityManager } from '../src/runtime/setup-authority.js';
import { createSetupAuthorityStateStore } from '../src/state/setup-authority-state-store.js';
import { resolveSetupProfileSelection } from '../src/setup/profile-selection.js';

const policy = {
  defaultProfiles: ['profile-a'],
  choices: { first: ['profile-a'], second: ['profile-b'], both: ['profile-a', 'profile-b'], none: [] },
};

test('neutral profile selection resolves default, accepted, working, explicit, empty, and deferred choices', () => {
  assert.deepEqual(resolveSetupProfileSelection({}, policy), {
    state: 'selected', profiles: ['profile-a'], pendingProfiles: null, source: 'default',
  });
  assert.equal(resolveSetupProfileSelection({ acceptedProfiles: [] }, policy).source, 'accepted');
  assert.deepEqual(resolveSetupProfileSelection({ acceptedProfiles: ['profile-a'] }, policy).profiles, ['profile-a']);
  assert.deepEqual(resolveSetupProfileSelection({ acceptedProfiles: ['profile-a'], workingProfiles: ['profile-b'] }, policy), {
    state: 'selected', profiles: ['profile-b'], pendingProfiles: null, source: 'working',
  });
  assert.deepEqual(resolveSetupProfileSelection({ choice: 'both' }, policy).profiles, ['profile-a', 'profile-b']);
  assert.deepEqual(resolveSetupProfileSelection({ choice: 'none' }, policy).profiles, []);
  assert.deepEqual(resolveSetupProfileSelection({
    choice: 'defer', acceptedProfiles: ['profile-a'], workingProfiles: ['profile-b'],
  }, policy), {
    state: 'deferred', profiles: ['profile-a'], pendingProfiles: ['profile-b'], source: 'explicit',
  });
});

test('neutral profile selection rejects unknown choices and malformed policy', () => {
  assert.throws(() => resolveSetupProfileSelection({ choice: 'unknown' }, policy), /unsupported/u);
  assert.throws(() => resolveSetupProfileSelection({ extra: true }, policy), /extra is not allowed/u);
  assert.throws(() => resolveSetupProfileSelection({}, { ...policy, extra: true }), /extra is not allowed/u);
  assert.throws(() => resolveSetupProfileSelection({}, { ...policy, defaultProfiles: ['../escape'] }), /invalid/u);
  assert.throws(() => resolveSetupProfileSelection({}, { ...policy, choices: { defer: [] } }), /deferred profile choice/u);
});

test('application selection defaults once, preserves accepted state, and replaces it transactionally', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-profile-selection-'));
  const stateDirectory = path.join(root, 'state');
  let tick = 0;
  const dependencies = {
    now: () => new Date(1_800_000_000_000 + tick++ * 1000).toISOString(),
    id: () => `setup-profile-${tick}`,
  };
  try {
    const first = await reconcileSetupProfileSelection({ stateDirectory }, dependencies);
    assert.deepEqual(first, {
      protocol: 'devbridge/setup-profile-selection-status-v1',
      state: 'accepted', revision: 1, changed: true,
      profiles: ['linux-development'], pendingProfiles: null, source: 'default',
    });
    const preserved = await reconcileSetupProfileSelection({ stateDirectory }, dependencies);
    assert.equal(preserved.changed, false);
    assert.equal(preserved.revision, 1);
    assert.deepEqual(preserved.profiles, ['linux-development']);

    const both = await reconcileSetupProfileSelection({ stateDirectory, choice: 'both' }, dependencies);
    assert.equal(both.revision, 2);
    assert.equal(both.changed, true);
    assert.deepEqual(both.profiles, ['linux-development', 'windows-development']);

    const deferred = await reconcileSetupProfileSelection({ stateDirectory, choice: 'defer' }, dependencies);
    assert.equal(deferred.state, 'deferred');
    assert.equal(deferred.revision, 2);
    assert.equal(deferred.changed, false);
    assert.deepEqual(deferred.profiles, both.profiles);

    const none = await reconcileSetupProfileSelection({ stateDirectory, choice: 'none' }, dependencies);
    assert.equal(none.revision, 3);
    assert.deepEqual(none.profiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application selection resumes the exact interrupted working profile generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-profile-resume-'));
  const stateDirectory = path.join(root, 'state');
  const file = path.join(stateDirectory, 'setup-authority.json');
  let tick = 0;
  const dependencies = {
    now: () => new Date(1_800_100_000_000 + tick++ * 1000).toISOString(),
    id: () => `setup-profile-resume-${tick}`,
  };
  try {
    const manager = new SetupAuthorityManager({
      port: createSetupAuthorityStateStore(file),
      now: dependencies.now,
      id: () => 'profile-selection-resume-seeded',
    });
    let record = (await manager.begin()).record;
    record = await manager.replaceProfiles(record.working.operationId, { requestedProfiles: ['windows-development'] });
    assert.equal(record.working.validation, 'pending');

    const resumed = await reconcileSetupProfileSelection({ stateDirectory }, dependencies);
    assert.equal(resumed.state, 'accepted');
    assert.equal(resumed.revision, 1);
    assert.equal(resumed.source, 'working');
    assert.deepEqual(resumed.profiles, ['windows-development']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application selection passes accepted state to another transaction owner without absorbing its work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-profile-owner-'));
  const stateDirectory = path.join(root, 'state');
  const file = path.join(stateDirectory, 'setup-authority.json');
  try {
    const accepted = await reconcileSetupProfileSelection({ stateDirectory, choice: 'windows' });
    assert.deepEqual(accepted.profiles, ['windows-development']);
    const manager = new SetupAuthorityManager({
      port: createSetupAuthorityStateStore(file),
      id: () => 'foreign-setup-operation',
    });
    const working = (await manager.begin()).record;
    const observed = await reconcileSetupProfileSelection({ stateDirectory });
    assert.equal(observed.changed, false);
    assert.equal(observed.source, 'accepted');
    assert.deepEqual(observed.profiles, ['windows-development']);
    await assert.rejects(
      reconcileSetupProfileSelection({ stateDirectory, choice: 'both' }),
      /owned by another setup component/u,
    );
    const preserved = await manager.current();
    assert.equal(preserved.working.operationId, working.working.operationId);
    assert.equal(preserved.revision, 1);
    assert.deepEqual(preserved.accepted.requestedProfiles, ['windows-development']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('neutral selection policy contains no current topology identities', async () => {
  const source = await readFile(new URL('../src/setup/profile-selection.js', import.meta.url), 'utf8');
  for (const forbidden of ['linux', 'windows', 'provider', 'hyper-v', 'libvirt', 'repository', 'virtual machine', 'media']) {
    assert.equal(source.toLowerCase().includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(source, /^import\s/mu);
});
