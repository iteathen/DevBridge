import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { APPLICATION_REMOVAL_PROTOCOL, createApplicationRemoval } from '../src/app/application-removal.js';
import { createRevisionedRecordStateStore } from '../src/state/revisioned-record-state-store.js';

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function snapshot() {
  return {
    protocol: APPLICATION_REMOVAL_PROTOCOL,
    generation: 'generation-one',
    coverage: ['application'],
    mutationActive: false,
    protectedReferences: [],
    items: [{
      identity: 'item-one',
      scope: 'payload',
      provenance: 'created',
      protections: [],
      references: [],
      after: [],
      effects: [{ identity: 'effect-one', bytes: 1, terminal: true }],
    }],
  };
}

function removal(file, state) {
  return createApplicationRemoval({
    source: {
      async snapshot() { return snapshot(); },
      async run(_mode, operation) { return operation(); },
    },
    journal: createRevisionedRecordStateStore(file),
    effects: {
      async bind(input) {
        return {
          protocol: APPLICATION_REMOVAL_PROTOCOL,
          mode: input.mode,
          item: input.item,
          identity: input.effect.identity,
          planDigest: input.planDigest,
          bound: true,
        };
      },
      async observe(input) {
        return { identity: input.effect.identity, state: state.present ? 'present' : 'absent', retryable: true };
      },
      async remove(input) {
        state.calls += 1;
        await state.remove(input);
      },
      async retire(input) {
        return { identity: input.effect.identity, retired: true };
      },
    },
  });
}

test('a fresh coordinator resumes a durable attempted effect by observation without replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-removal-resume-'));
  const file = path.join(root, 'journal.json');
  let interrupt = true;
  const state = {
    present: true,
    calls: 0,
    async remove() {
      this.present = false;
      if (interrupt) throw new Error('simulated interruption');
    },
  };
  try {
    const first = removal(file, state);
    const plan = await first.inspect({ mode: 'application' });
    await assert.rejects(
      () => first.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' }),
      /simulated interruption/u,
    );
    assert.equal(state.calls, 1);

    interrupt = false;
    const restarted = removal(file, state);
    const result = await restarted.remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
    assert.equal(result.complete, true);
    assert.deepEqual(result.removed, ['item-one']);
    assert.equal(state.calls, 1);
    const repeated = await removal(file, state).remove({ mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' });
    assert.equal(repeated.complete, true);
    assert.equal(state.calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('independent coordinators cannot enter the same effect loop concurrently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-removal-exclusive-'));
  const file = path.join(root, 'journal.json');
  const entered = deferred();
  const release = deferred();
  const state = {
    present: true,
    calls: 0,
    async remove() {
      entered.resolve();
      await release.promise;
      this.present = false;
    },
  };
  try {
    const first = removal(file, state);
    const second = removal(file, state);
    const plan = await first.inspect({ mode: 'application' });
    const request = { mode: 'application', planDigest: plan.digest, confirmation: 'REMOVE' };
    const active = first.remove(request);
    await entered.promise;
    const waiting = second.remove(request);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(state.calls, 1);
    release.resolve();
    const results = await Promise.all([active, waiting]);
    assert.ok(results.every((result) => result.complete));
    assert.equal(state.calls, 1);
  } finally {
    release.resolve();
    await rm(root, { recursive: true, force: true });
  }
});
