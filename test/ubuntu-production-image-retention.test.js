import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUbuntuProductionImageRetention } from '../src/app/ubuntu-production-image-retention.js';
import { JsonStateStore } from '../src/state/json-state-store.js';

const current = 'subject-11111111111111111111111111111111';
const accepted = 'subject-22222222222222222222222222222222';
const recoverable = 'subject-33333333333333333333333333333333';
const obsolete = 'subject-44444444444444444444444444444444';
const image = 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function journal(identity, phase, imageIdentity = null) {
  return {
    protocol: 'devbridge/canonical-image-canary-v1',
    identity,
    requestDigest: identity.slice(8).repeat(2),
    revision: 1,
    phase,
    probe: null,
    finalization: null,
    image: imageIdentity == null ? null : { identity: imageIdentity },
  };
}

async function seed(root, entries) {
  const state = path.join(root, 'state', 'production-image-canary');
  const authorities = new JsonStateStore(path.join(state, 'authority.json'));
  const journals = new JsonStateStore(path.join(state, 'journal.json'));
  for (const entry of entries) {
    await authorities.set(`authority:${entry.identity}`, { identity: entry.identity });
    await journals.set(`canonical-image-canary:${entry.identity}`, journal(entry.identity, entry.phase, entry.image ?? null));
  }
  return { stateDirectory: path.join(root, 'state'), authorities, journals };
}

function dependencies(images = []) {
  const records = new Map();
  return {
    platform: 'linux',
    identityReader: async () => 'b'.repeat(32),
    constructionFactory: () => ({
      async listRetirementRecords() { return [...records.values()]; },
      async retirementStatus(identity) {
        const record = records.get(identity);
        return record == null
          ? { identity, exists: false, provider: null, disk: null }
          : { identity, exists: true, provider: { exists: false, state: 'absent' }, disk: { exists: false, attached: false } };
      },
      async retireProvider() { throw new Error('provider retirement is not expected'); },
      async retireRecord(identity) { records.delete(identity); return { identity, retired: true }; },
    }),
    imageLibraryFactory: () => ({ async list() { return structuredClone(images); } }),
    artifactSetFactory: () => ({
      async plan() { throw new Error('artifact planning is not expected'); },
      async discover() { throw new Error('artifact discovery is not expected'); },
      async observe() { throw new Error('artifact observation is not expected'); },
      async remove() { throw new Error('artifact retirement is not expected'); },
    }),
    attributeObserverFactory: () => ({ isReparse: async () => false }),
  };
}

test('production image retention composes current, accepted, superseded, and obsolete records without exposing topology', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-production-retention-'));
  try {
    const stores = await seed(root, [
      { identity: current, phase: 'completed' },
      { identity: accepted, phase: 'completed', image },
      { identity: recoverable, phase: 'planned' },
      { identity: obsolete, phase: 'completed' },
    ]);
    const progress = [];
    const retention = await createUbuntuProductionImageRetention(
      { stateDirectory: stores.stateDirectory, currentSubject: current, onProgress: (event) => progress.push(event) },
      dependencies([{ identity: image, provenance: { authority: accepted } }]),
    );
    const plan = await retention.inspect();
    assert.deepEqual(Object.fromEntries(plan.subjects.map((entry) => [entry.identity, entry.classification])), {
      [current]: 'current',
      [accepted]: 'accepted',
      [recoverable]: 'obsolete',
      [obsolete]: 'obsolete',
    });
    assert.equal(plan.subjects.find((entry) => entry.identity === recoverable).eligible, true);
    assert.equal(plan.subjects.find((entry) => entry.identity === obsolete).eligible, true);
    assert.equal(JSON.stringify(plan).includes(root), false);
    assert.equal(JSON.stringify(plan).includes('Hyper-V'), false);

    const result = await retention.retire({ identity: obsolete, planDigest: plan.digest });
    assert.equal(result.complete, true);
    const authorities = new JsonStateStore(path.join(stores.stateDirectory, 'production-image-canary', 'authority.json'));
    const journals = new JsonStateStore(path.join(stores.stateDirectory, 'production-image-canary', 'journal.json'));
    assert.equal(await authorities.get(`authority:${obsolete}`), undefined);
    assert.equal(await journals.get(`canonical-image-canary:${obsolete}`), undefined);
    assert.notEqual(await authorities.get(`authority:${current}`), undefined);
    assert.ok(progress.some((entry) => entry.phase === 'planning'));
    assert.ok(progress.some((entry) => entry.phase === 'binding'));
    assert.doesNotMatch(JSON.stringify(progress), /subject-|path|identity|digest/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production image retention fails closed on unknown durable phases', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-production-retention-phase-'));
  try {
    const stores = await seed(root, [
      { identity: current, phase: 'completed' },
      { identity: obsolete, phase: 'unsupported' },
    ]);
    const retention = await createUbuntuProductionImageRetention(
      { stateDirectory: stores.stateDirectory, currentSubject: current },
      dependencies(),
    );
    const plan = await retention.inspect();
    assert.equal(plan.subjects.find((entry) => entry.identity === obsolete).classification, 'ambiguous');
    assert.equal(plan.subjects.find((entry) => entry.identity === obsolete).eligible, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production image retention protects a derived current subject before its first registration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-production-retention-current-'));
  try {
    const stores = await seed(root, [{ identity: obsolete, phase: 'completed' }]);
    const retention = await createUbuntuProductionImageRetention(
      { stateDirectory: stores.stateDirectory, currentSubject: current },
      dependencies(),
    );
    const plan = await retention.inspect();
    assert.equal(plan.subjects.find((entry) => entry.identity === current).classification, 'current');
    assert.equal(plan.subjects.find((entry) => entry.identity === current).eligible, false);
    assert.equal(plan.subjects.find((entry) => entry.identity === obsolete).classification, 'obsolete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production image retention crosses provider, exact artifact, and terminal record ports in order', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-production-retention-effects-'));
  try {
    const stores = await seed(root, [
      { identity: current, phase: 'completed' },
      { identity: obsolete, phase: 'completed' },
    ]);
    const key = 'construction-4444444444444444';
    const diskName = 'construction-4444444444444444.vhdx';
    await mkdir(path.join(stores.stateDirectory, 'production-image-canary', 'output', `${key}-vm`), { recursive: true });
    let recordPresent = true;
    let providerPresent = true;
    let diskPresent = true;
    const artifacts = new Map();
    const calls = [];
    const manifest = (identity, role, bytes) => {
      const value = { identity, role, bytes };
      artifacts.set(identity, true);
      return value;
    };
    const retention = await createUbuntuProductionImageRetention(
      { stateDirectory: stores.stateDirectory, currentSubject: current },
      {
        platform: 'linux',
        identityReader: async () => 'b'.repeat(32),
        constructionFactory: () => ({
          async listRetirementRecords() {
            return recordPresent ? [{ identity: obsolete, phase: 'accepted', key, diskName, diskBytes: 64 }] : [];
          },
          async retirementStatus(identity) {
            return recordPresent
              ? {
                  identity,
                  exists: true,
                  provider: { exists: providerPresent, state: providerPresent ? 'off' : 'absent' },
                  disk: { exists: diskPresent, attached: false, allocatedBytes: diskPresent ? 10 : 0 },
                }
              : { identity, exists: false, provider: null, disk: null };
          },
          async retireProvider(identity) { calls.push('provider'); providerPresent = false; return { identity, retired: true }; },
          async retireRecord(identity) { calls.push('records'); recordPresent = false; return { identity, retired: true }; },
        }),
        imageLibraryFactory: () => ({ async list() { return []; } }),
        artifactSetFactory: () => ({
          async discover({ identity }) { return manifest(identity, 'configuration', 4); },
          async plan({ identity }) { return manifest(identity, 'output', 10); },
          async observe(value) { return { identity: value.identity, state: artifacts.get(value.identity) ? 'present' : 'absent', retryable: true }; },
          async remove(value) {
            calls.push(value.role);
            artifacts.set(value.identity, false);
            if (value.role === 'output') diskPresent = false;
            return { identity: value.identity, removed: true };
          },
        }),
        attributeObserverFactory: () => ({ isReparse: async () => false }),
      },
    );
    const plan = await retention.inspect();
    assert.equal(plan.subjects.find((entry) => entry.identity === obsolete).effectCount, 4);
    const result = await retention.retire({ identity: obsolete, planDigest: plan.digest });
    assert.equal(result.complete, true);
    assert.deepEqual(calls, ['provider', 'configuration', 'output', 'records']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
