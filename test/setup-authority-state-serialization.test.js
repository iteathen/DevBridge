import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileSetupImageDistributionPolicy } from '../src/app/setup-image-distribution-policy.js';
import { reconcileSetupProfileSelection } from '../src/app/setup-profile-selection.js';
import { reconcileSetupWindowsActivationPolicy } from '../src/app/setup-windows-activation-policy.js';
import { SetupAuthorityManager, createSetupAuthoritySnapshot } from '../src/runtime/setup-authority.js';
import { createExclusiveMutation } from '../src/state/setup-authority-state-store/exclusive-mutation.js';
import { createSetupAuthorityStateStore } from '../src/state/setup-authority-state-store.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/setup-authority-process.mjs', import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function child(args) {
  const processHandle = spawn(process.execPath, [FIXTURE, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let errorOutput = '';
  const ready = deferred();
  processHandle.stdout.setEncoding('utf8');
  processHandle.stderr.setEncoding('utf8');
  processHandle.stdout.on('data', (value) => {
    output += value;
    if (output.split(/\r?\n/u).includes('ready')) ready.resolve();
  });
  processHandle.stderr.on('data', (value) => { errorOutput += value; });
  const completed = new Promise((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('close', (code, signal) => {
      if (code === 0) resolve(output.split(/\r?\n/u).filter(Boolean).at(-1));
      else reject(new Error(`fixture failed with code ${code} signal ${signal}: ${errorOutput}`));
    });
  });
  return { processHandle, ready: ready.promise, completed };
}

test('independent managers create one working generation and resume its exact identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-serial-'));
  try {
    for (let index = 0; index < 25; index += 1) {
      const target = path.join(root, `state-${index}.json`);
      const first = new SetupAuthorityManager({
        port: createSetupAuthorityStateStore(target),
        id: () => `operation-first-${index}`,
      });
      const second = new SetupAuthorityManager({
        port: createSetupAuthorityStateStore(target),
        id: () => `operation-second-${index}`,
      });
      const results = await Promise.all([first.begin(), second.begin()]);
      assert.equal(results.filter((value) => value.resumed === false).length, 1);
      assert.equal(results.filter((value) => value.resumed === true).length, 1);
      assert.equal(results[0].record.working.operationId, results[1].record.working.operationId);
    }
    assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('independent state adapters serialize fresh transforms and release after failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-transform-'));
  const target = path.join(root, 'state.json');
  try {
    const first = createSetupAuthorityStateStore(target);
    const second = createSetupAuthorityStateStore(target);
    const entered = deferred();
    const release = deferred();
    let secondEntered = false;
    const firstMutation = first.mutate(async (current) => {
      assert.equal(current, undefined);
      entered.resolve();
      await release.promise;
      return { next: { sequence: ['first'] }, result: 'first' };
    });
    await entered.promise;
    const secondMutation = second.mutate((current) => {
      secondEntered = true;
      assert.deepEqual(current, { sequence: ['first'] });
      return { next: { sequence: [...current.sequence, 'second'] }, result: 'second' };
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondEntered, false);
    release.resolve();
    assert.deepEqual(await Promise.all([firstMutation, secondMutation]), ['first', 'second']);
    assert.deepEqual(await first.load(), { sequence: ['first', 'second'] });

    await assert.rejects(() => first.mutate(() => { throw new Error('transform stopped'); }), /transform stopped/u);
    assert.equal(await second.mutate((current) => ({ next: { ...current, released: true }, result: 'released' })), 'released');
    assert.deepEqual(await second.load(), { sequence: ['first', 'second'], released: true });
    assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exclusive mutation contention is bounded and the exact target is reusable after release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-bound-'));
  const target = path.join(root, 'state.json');
  const entered = deferred();
  const release = deferred();
  try {
    const hold = createExclusiveMutation()(target, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const contender = createExclusiveMutation({ maximumWaitMs: 25, retryDelayMs: 5 });
    await assert.rejects(
      () => contender(target, async () => 'unreachable'),
      (error) => error?.code === 'EXCLUSIVE_MUTATION_BUSY',
    );
    release.resolve();
    await hold;
    assert.equal(await contender(target, async () => 'reused'), 'reused');
  } finally {
    release.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test('state publication preserves unrelated envelope values and leaves exact JSON without temporary files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-envelope-'));
  const target = path.join(root, 'state.json');
  try {
    await writeFile(target, `${JSON.stringify({ retained: { value: 7 } }, null, 2)}\n`, 'utf8');
    const manager = new SetupAuthorityManager({
      port: createSetupAuthorityStateStore(target),
      id: () => 'operation-envelope',
    });
    await manager.begin();
    const document = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(document.retained, { value: 7 });
    assert.equal(document['setup:authority'].working.operationId, 'operation-envelope');
    assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent terminal mutations cannot overwrite the surviving accepted or working state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-terminal-'));
  const target = path.join(root, 'state.json');
  try {
    const first = new SetupAuthorityManager({ port: createSetupAuthorityStateStore(target), id: () => 'operation-terminal' });
    const second = new SetupAuthorityManager({ port: createSetupAuthorityStateStore(target), id: () => 'unused-operation' });
    let record = (await first.begin()).record;
    record = await first.markValidation(record.working.operationId, 'passed');
    const results = await Promise.allSettled([
      first.commit(record.working.operationId),
      second.discard(record.working.operationId),
    ]);
    assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
    assert.equal(results.filter((value) => value.status === 'rejected').length, 1);
    const observed = await first.current();
    if (observed.revision === 1) {
      assert.equal(observed.accepted.protocol, 'devbridge/setup-authority-snapshot-v1');
      assert.equal(observed.working, null);
    } else {
      assert.equal(observed.revision, 0);
      assert.equal(observed.accepted, null);
      assert.equal(observed.working, null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent disjoint edits preserve both changes before validation and commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-edits-'));
  const target = path.join(root, 'state.json');
  try {
    const first = new SetupAuthorityManager({ port: createSetupAuthorityStateStore(target), id: () => 'operation-edits' });
    const second = new SetupAuthorityManager({ port: createSetupAuthorityStateStore(target), id: () => 'unused-operation' });
    let record = (await first.begin()).record;
    record = await first.replaceProfiles(record.working.operationId, {
      requestedProfiles: ['profile-a'],
      requirements: [
        { profile: 'profile-a', class: 'construction', requirement: 'required' },
        { profile: 'profile-a', class: 'distribution', requirement: 'required' },
      ],
    });
    const construction = record.working.snapshot.authorities.find((value) => value.class === 'construction');
    const distribution = record.working.snapshot.authorities.find((value) => value.class === 'distribution');
    await Promise.all([
      first.replaceAuthority(record.working.operationId, {
        ...construction,
        subjectRef: 'subject-00000000000000000000000000000001',
        provenance: 'manual',
        approval: 'approved',
        availability: 'available',
      }),
      second.replaceAuthority(record.working.operationId, {
        ...distribution,
        subjectRef: 'subject-00000000000000000000000000000002',
        provenance: 'manual',
        approval: 'approved',
        availability: 'available',
      }),
    ]);
    record = await first.current();
    assert.equal(record.working.snapshot.authorities.find((value) => value.class === 'construction').availability, 'available');
    assert.equal(record.working.snapshot.authorities.find((value) => value.class === 'distribution').availability, 'available');
    record = await first.markValidation(record.working.operationId, 'passed');
    record = await first.commit(record.working.operationId);
    assert.equal(record.revision, 1);
    assert.equal(record.accepted.authorities.filter((value) => value.availability === 'available').length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('separate processes serialize begin against the exact state adapter', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-process-'));
  const target = path.join(root, 'state.json');
  const signal = path.join(root, 'go');
  try {
    const first = child(['begin', target, 'operation-process-first', signal]);
    const second = child(['begin', target, 'operation-process-second', signal]);
    await Promise.all([first.ready, second.ready]);
    await writeFile(signal, 'go', 'utf8');
    const results = (await Promise.all([first.completed, second.completed])).map((value) => JSON.parse(value));
    assert.equal(results.filter((value) => value.resumed === false).length, 1);
    assert.equal(results.filter((value) => value.resumed === true).length, 1);
    assert.equal(results[0].record.working.operationId, results[1].record.working.operationId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('process exit releases an in-progress state lease without stale cleanup', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-crash-'));
  const target = path.join(root, 'state.json');
  try {
    const holder = child(['hold', target, 'unused', 'unused']);
    await holder.ready;
    holder.processHandle.kill();
    await assert.rejects(holder.completed, /fixture failed/u);
    const manager = new SetupAuthorityManager({
      port: createSetupAuthorityStateStore(target),
      id: () => 'operation-after-exit',
    });
    const started = await manager.begin();
    assert.equal(started.resumed, false);
    assert.equal(started.record.working.operationId, 'operation-after-exit');
    assert.equal((await readdir(root)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function racedManager(record) {
  let mutated = false;
  return {
    manager: {
      current: async () => record,
      begin: async () => ({ resumed: true, record: {
        ...record,
        working: {
          operationId: 'foreign-operation',
          baseRevision: record?.revision ?? 0,
          snapshot: record?.accepted ?? createSetupAuthoritySnapshot(),
          validation: 'pending',
          updatedAt: '2027-01-15T08:00:00.000Z',
        },
      } }),
      replaceProfiles: async () => { mutated = true; },
      replaceAuthority: async () => { mutated = true; },
      markValidation: async () => { mutated = true; },
      commit: async () => { mutated = true; },
    },
    wasMutated: () => mutated,
  };
}

function requiredSnapshot(profile, authorityClass) {
  return createSetupAuthoritySnapshot({
    requestedProfiles: [profile],
    requirements: [{ profile, class: authorityClass, requirement: 'required' }],
  });
}

test('setup callers reject a working generation that appeared after their observation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-caller-'));
  try {
    const profileRace = racedManager(null);
    await assert.rejects(() => reconcileSetupProfileSelection({
      stateDirectory: root,
      choice: 'windows',
    }, { managerFactory: () => profileRace.manager }), /changed while starting/u);
    assert.equal(profileRace.wasMutated(), false);

    const distributionRace = racedManager({
      protocol: 'devbridge/setup-authority-record-v1',
      revision: 1,
      accepted: requiredSnapshot('linux-development', 'distribution'),
      working: null,
      updatedAt: '2027-01-15T08:00:00.000Z',
    });
    await assert.rejects(() => reconcileSetupImageDistributionPolicy({
      stateDirectory: root,
      profile: 'linux-development',
      choice: 'local-reconstruction',
    }, {
      storeFactory: () => ({ load: async () => null, save: async () => {} }),
      managerFactory: () => distributionRace.manager,
    }), /changed while starting/u);
    assert.equal(distributionRace.wasMutated(), false);

    const activationRace = racedManager({
      protocol: 'devbridge/setup-authority-record-v1',
      revision: 1,
      accepted: requiredSnapshot('windows-development', 'activation'),
      working: null,
      updatedAt: '2027-01-15T08:00:00.000Z',
    });
    await assert.rejects(() => reconcileSetupWindowsActivationPolicy({
      stateDirectory: root,
      choice: 'later',
    }, {
      storeFactory: () => ({ load: async () => null, save: async () => {} }),
      managerFactory: () => activationRace.manager,
    }), /changed while starting/u);
    assert.equal(activationRace.wasMutated(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
