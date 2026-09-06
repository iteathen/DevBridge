import { copyFile, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginAcceleratorBrokerGenerationRetirement,
  createAcceleratorBrokerGenerationStateRecord,
  promoteAcceleratorBrokerGeneration,
} from '../src/runtime/accelerator-broker-generation-state.js';
import { FileAcceleratorBrokerGenerationStateStore } from '../src/runtime/accelerator-broker-file-generation-state.js';

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-accelerator-generation-state-'));
  const canonical = await realpath(root);
  t.after(() => rm(canonical, { recursive: true, force: true }));
  return canonical;
}

function key() {
  return { sessionIdentity: 'broker-session-a' };
}

function initial() {
  return createAcceleratorBrokerGenerationStateRecord({
    sessionIdentity: 'broker-session-a',
    generation: 'generation-1',
  });
}

async function onlyKeyDirectory(root) {
  const fanouts = await readdir(root);
  assert.equal(fanouts.length, 1);
  const fanoutPath = path.join(root, fanouts[0]);
  const keys = await readdir(fanoutPath);
  assert.equal(keys.length, 1);
  return path.join(fanoutPath, keys[0]);
}

test('file generation state store persists exact lifecycle state across reopen', async (t) => {
  const root = await tempRoot(t);
  const store = new FileAcceleratorBrokerGenerationStateStore({ rootPath: root });
  const active = initial();
  assert.equal(await store.create(key(), active), true);
  const retiring = beginAcceleratorBrokerGenerationRetirement(active, {
    operationId: 'retirement-1',
    nextGeneration: 'generation-2',
  });
  assert.equal(await store.compareAndSwap(key(), 1, retiring), true);
  const promoted = promoteAcceleratorBrokerGeneration(retiring, { operationId: 'retirement-1' });
  assert.equal(await store.compareAndSwap(key(), 2, promoted), true);

  const reopened = new FileAcceleratorBrokerGenerationStateStore({ rootPath: root });
  assert.deepEqual(await reopened.load(key()), promoted);
});

test('concurrent generation state create and CAS have exactly one durable winner', async (t) => {
  const root = await tempRoot(t);
  const left = new FileAcceleratorBrokerGenerationStateStore({ rootPath: root });
  const right = new FileAcceleratorBrokerGenerationStateStore({ rootPath: root });
  const active = initial();
  const createResults = await Promise.all([left.create(key(), active), right.create(key(), active)]);
  assert.equal(createResults.filter(Boolean).length, 1);

  const retiring = beginAcceleratorBrokerGenerationRetirement(active, {
    operationId: 'retirement-1',
    nextGeneration: 'generation-2',
  });
  const casResults = await Promise.all([
    left.compareAndSwap(key(), 1, retiring),
    right.compareAndSwap(key(), 1, retiring),
  ]);
  assert.equal(casResults.filter(Boolean).length, 1);
  assert.deepEqual(await left.load(key()), retiring);
  assert.equal(await left.compareAndSwap(key(), 1, retiring), false);
});

test('generation state storage paths never contain the logical session identity', async (t) => {
  const root = await tempRoot(t);
  const store = new FileAcceleratorBrokerGenerationStateStore({ rootPath: root });
  await store.create(key(), initial());
  const fanouts = await readdir(root);
  assert.equal(fanouts.length, 1);
  assert.match(fanouts[0], /^[0-9a-f]{2}$/u);
  const keyNames = await readdir(path.join(root, fanouts[0]));
  assert.equal(keyNames.length, 1);
  assert.match(keyNames[0], /^[0-9a-f]{64}$/u);
  assert.equal(`${fanouts[0]}${keyNames[0]}`.includes('broker-session-a'), false);
});

test('generation state store fails closed on malformed and gapped immutable history', async (t) => {
  const root = await tempRoot(t);
  const store = new FileAcceleratorBrokerGenerationStateStore({ rootPath: root });
  await store.create(key(), initial());
  const directory = await onlyKeyDirectory(root);
  await copyFile(path.join(directory, '0000000000000001.json'), path.join(directory, '0000000000000003.json'));
  await assert.rejects(() => store.load(key()), /history is not contiguous/u);
  await rm(path.join(directory, '0000000000000003.json'));
  await writeFile(path.join(directory, '0000000000000001.json'), '{not-json}\n', 'utf8');
  await assert.rejects(() => store.load(key()), /revision is malformed/u);
});

test('generation state store fails closed on unexpected namespace entries', async (t) => {
  const root = await tempRoot(t);
  const store = new FileAcceleratorBrokerGenerationStateStore({ rootPath: root });
  await store.create(key(), initial());
  const directory = await onlyKeyDirectory(root);
  await writeFile(path.join(directory, 'unexpected.txt'), 'x', 'utf8');
  await assert.rejects(() => store.load(key()), /unexpected entry/u);
});

test('generation state store enforces serialized record size bounds', async (t) => {
  const root = await tempRoot(t);
  const store = new FileAcceleratorBrokerGenerationStateStore({ rootPath: root, maxRecordBytes: 32 });
  await assert.rejects(() => store.create(key(), initial()), /record is oversized/u);
});

test('generation state store rejects symlink revision substitution where supported', async (t) => {
  if (process.platform === 'win32') {
    t.skip('unprivileged Windows CI does not guarantee symlink creation');
    return;
  }
  const root = await tempRoot(t);
  const store = new FileAcceleratorBrokerGenerationStateStore({ rootPath: root });
  await store.create(key(), initial());
  const directory = await onlyKeyDirectory(root);
  const revision = path.join(directory, '0000000000000001.json');
  const target = path.join(root, 'replacement.json');
  await copyFile(revision, target);
  await rm(revision);
  await symlink(target, revision);
  await assert.rejects(() => store.load(key()), /invalid revision entry|not a regular file/u);
});
