import { mutationLease } from '../test-support/mutation-lease.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentLedger } from '../src/runtime/persistent-environments/ledger.js';

const PROTOCOL = 'devbridge/persistent-environments-v1';

test('nested ledger publishes exact revisioned state and reloads it independently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-environment-ledger-'));
  try {
    const first = new EnvironmentLedger({ directory: root, lease: mutationLease(root), protocol: PROTOCOL });
    await first.run(async () => {
      const state = await first.read();
      assert.deepEqual(state, { protocol: PROTOCOL, revision: 0, entries: {}, operations: {} });
      state.entries.slot = { current: { identity: 'env-a' } };
      await first.commit(state);
      assert.equal(state.revision, 1);
    });

    const second = new EnvironmentLedger({ directory: root, lease: mutationLease(root), protocol: PROTOCOL });
    const observed = await second.run(() => second.read());
    assert.equal(observed.revision, 1);
    assert.equal(observed.entries.slot.current.identity, 'env-a');
    assert.equal(JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8')).protocol, PROTOCOL);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nested ledger serializes local work and rejects a concurrent external owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-environment-ledger-guard-'));
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  try {
    const first = new EnvironmentLedger({ directory: root, lease: mutationLease(root), protocol: PROTOCOL });
    const second = new EnvironmentLedger({ directory: root, lease: mutationLease(root), protocol: PROTOCOL });
    const active = first.run(async () => {
      enter();
      await blocked;
    });
    await entered;
    await assert.rejects(() => second.run(() => second.read()), /lifecycle mutation is already active/u);
    release();
    await active;
    await second.run(() => second.read());
  } finally {
    release?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy token guards remain intact while committed status stays readable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-environment-ledger-token-'));
  try {
    const ledger = new EnvironmentLedger({ directory: root, lease: mutationLease(root), protocol: PROTOCOL });
    await writeFile(path.join(root, 'lifecycle.lock'), 'retained-legacy-token\n', 'utf8');
    assert.equal(await ledger.snapshot((state) => state.revision), 0);
    await assert.rejects(() => ledger.run(() => assert.fail('must not mutate')), /quiescent authority owner/u);
    assert.equal(await readFile(path.join(root, 'lifecycle.lock'), 'utf8'), 'retained-legacy-token\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lease loss prevents a later commit and does not block independent status', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ledger-loss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let held;
  const lease = mutationLease(root);
  const ledger = new EnvironmentLedger({ directory: root, protocol: PROTOCOL, lease: { async acquire(input) { held = await lease.acquire(input); return held; } } });
  await assert.rejects(ledger.run(async () => {
    const state = await ledger.read();
    await ledger.commit(state);
    assert.equal(await ledger.snapshot((value) => value.revision), 1);
    await held.release();
    state.entries.foreign = {};
    await ledger.commit(state);
  }), /mutation lease lost/u);
  const observed = await ledger.snapshot((state) => state);
  assert.equal(observed.revision, 1);
  assert.deepEqual(observed.entries, {});
  const replacement = new EnvironmentLedger({ directory: root, protocol: PROTOCOL, lease: mutationLease(root) });
  await replacement.run(() => replacement.read());
});
