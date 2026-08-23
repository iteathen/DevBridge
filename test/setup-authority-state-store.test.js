import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SetupAuthorityManager } from '../src/runtime/setup-authority.js';
import { createSetupAuthorityStateStore } from '../src/state/setup-authority-state-store.js';

function ref(number) {
  return `subject-${number.toString(16).padStart(32, '0')}`;
}

function authority(snapshot, profile, selectedClass) {
  return snapshot.authorities.find((entry) => entry.profile === profile && entry.class === selectedClass);
}

test('accepted authority remains intact while a restart resumes an edited working generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-setup-authority-'));
  const file = path.join(root, 'state.json');
  let tick = 0;
  const dependencies = {
    now: () => new Date(1_800_000_000_000 + tick++ * 1000).toISOString(),
    id: () => `setup-operation-${tick}`,
  };
  try {
    const first = new SetupAuthorityManager({ port: createSetupAuthorityStateStore(file), ...dependencies });
    let record = (await first.begin()).record;
    record = await first.replaceProfiles(record.working.operationId, {
      requestedProfiles: ['linux'],
      requirements: [
        { profile: 'linux', class: 'construction', requirement: 'required' },
        { profile: 'linux', class: 'distribution', requirement: 'none' },
        { profile: 'linux', class: 'activation', requirement: 'none' },
        { profile: 'linux', class: 'declaration', requirement: 'none' },
      ],
    });
    record = await first.replaceAuthority(record.working.operationId, {
      ...authority(record.working.snapshot, 'linux', 'construction'),
      subjectRef: ref(1), provenance: 'recommended', approval: 'approved', availability: 'available',
    });
    record = await first.markValidation(record.working.operationId, 'passed');
    record = await first.commit(record.working.operationId);
    assert.equal(record.revision, 1);

    record = (await first.begin()).record;
    record = await first.replaceAuthority(record.working.operationId, {
      ...authority(record.working.snapshot, 'linux', 'construction'), availability: 'unavailable',
    });
    assert.equal(record.accepted.authorities.find((entry) => entry.class === 'construction').availability, 'available');
    assert.equal(record.working.snapshot.authorities.find((entry) => entry.class === 'construction').availability, 'unavailable');

    const second = new SetupAuthorityManager({ port: createSetupAuthorityStateStore(file), ...dependencies });
    const resumed = await second.begin();
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.record.revision, 1);
    assert.equal(resumed.record.accepted.authorities.find((entry) => entry.class === 'construction').availability, 'available');
    assert.equal(resumed.record.working.snapshot.authorities.find((entry) => entry.class === 'construction').availability, 'unavailable');

    const discarded = await second.discard(resumed.record.working.operationId);
    assert.equal(discarded.working, null);
    assert.equal(discarded.accepted.authorities.find((entry) => entry.class === 'construction').availability, 'available');

    const third = new SetupAuthorityManager({ port: createSetupAuthorityStateStore(file), ...dependencies });
    const reloaded = await third.current();
    assert.equal(reloaded.revision, 1);
    assert.equal(reloaded.working, null);
    assert.equal(reloaded.accepted.authorities.find((entry) => entry.class === 'construction').subjectRef, ref(1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
