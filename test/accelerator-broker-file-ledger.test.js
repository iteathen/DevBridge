import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
  ACCELERATOR_BROKER_OPERATION,
  ACCELERATOR_BROKER_REASON,
  ACCELERATOR_BROKER_STATE,
  createAcceleratorBrokerObservation,
  digestAcceleratorBrokerExecuteRequest,
} from '../src/runtime/accelerator-broker-protocol.js';
import {
  acceleratorBrokerLedgerKey,
  advanceAcceleratorBrokerLedgerRecord,
  createAcceleratorBrokerLedgerRecord,
  normalizeAcceleratorBrokerLedgerKey,
} from '../src/runtime/accelerator-broker-ledger.js';
import { FileAcceleratorBrokerLedgerStore } from '../src/runtime/accelerator-broker-file-ledger.js';

function binding() {
  return {
    profile: 'profile.cuda',
    environment: { identity: 'environment.cuda', generation: 'environment-generation-1' },
    backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-1' },
    session: { identity: 'broker-session-a', generation: 'broker-session-generation-1' },
  };
}

function request(overrides = {}) {
  return {
    protocol: ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
    requestId: 'request-1',
    executionId: 'execution-1',
    binding: binding(),
    api: 'cuda',
    topology: 'host-retained',
    operation: ACCELERATOR_BROKER_OPERATION.CUDA_CANARY_U32_ADD_V1,
    input: { left: [1, 0xffff_ffff], right: [2, 1] },
    ...overrides,
  };
}

function observation(value, state, extra = {}) {
  return createAcceleratorBrokerObservation({
    requestId: value.requestId,
    executionId: value.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(value),
    binding: value.binding,
    api: value.api,
    topology: value.topology,
    operation: value.operation,
    state,
    reason: null,
    result: null,
    ...extra,
  });
}

function acceptedRecord(value = request()) {
  return createAcceleratorBrokerLedgerRecord({
    request: value,
    observation: observation(value, ACCELERATOR_BROKER_STATE.ACCEPTED),
  });
}

function runningRecord(first = acceptedRecord()) {
  return advanceAcceleratorBrokerLedgerRecord(first, {
    observation: observation(first.request, ACCELERATOR_BROKER_STATE.RUNNING),
  });
}

function unknownRecord(first = acceptedRecord()) {
  return advanceAcceleratorBrokerLedgerRecord(first, {
    observation: observation(first.request, ACCELERATOR_BROKER_STATE.UNKNOWN, { reason: ACCELERATOR_BROKER_REASON.STATE_UNKNOWN }),
  });
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-accelerator-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function keyDirectory(root) {
  const fanout = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.equal(fanout.length, 1);
  const fanoutPath = path.join(root, fanout[0].name);
  const keys = (await readdir(fanoutPath, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.equal(keys.length, 1);
  return path.join(fanoutPath, keys[0].name);
}

async function revisionPath(root, revision = 1) {
  return path.join(await keyDirectory(root), `${String(revision).padStart(16, '0')}.json`);
}

test('file ledger requires an existing canonical absolute directory root', async (t) => {
  assert.throws(() => new FileAcceleratorBrokerLedgerStore({ rootPath: 'relative-ledger' }), /rootPath must be absolute/u);
  const root = await tempRoot(t);
  const missing = new FileAcceleratorBrokerLedgerStore({ rootPath: path.join(root, 'missing') });
  await assert.rejects(() => missing.load(acceleratorBrokerLedgerKey(request())), /directory is unavailable/u);

  const filePath = path.join(root, 'not-a-directory');
  await writeFile(filePath, 'x', 'utf8');
  const fileStore = new FileAcceleratorBrokerLedgerStore({ rootPath: filePath });
  await assert.rejects(() => fileStore.load(acceleratorBrokerLedgerKey(request())), /directory is invalid/u);
});

test('create persists revision 1 and a fresh store instance reloads it after restart', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const record = acceptedRecord();
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await store.create(key, record), true);
  const loaded = await store.load(key);
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.observation.state, 'accepted');

  const reopened = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  const afterRestart = await reopened.load(key);
  assert.equal(afterRestart.revision, 1);
  assert.deepEqual(afterRestart, loaded);
});

test('CAS advances exactly one revision and stale CAS returns false without changing state', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const first = acceptedRecord();
  const second = runningRecord(first);
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await store.create(key, first), true);
  assert.equal(await store.compareAndSwap(key, 1, second), true);
  assert.equal((await store.load(key)).revision, 2);
  assert.equal(await store.compareAndSwap(key, 1, second), false);
  const current = await store.load(key);
  assert.equal(current.revision, 2);
  assert.equal(current.observation.state, 'running');
});

test('concurrent create publishes exactly one immutable revision 1', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const record = acceptedRecord();
  const left = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  const right = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  const outcomes = await Promise.all([left.create(key, record), right.create(key, record)]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal((await left.load(key)).revision, 1);
});

test('concurrent CAS from one revision has exactly one winner and preserves the winning record', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const first = acceptedRecord();
  const running = runningRecord(first);
  const unknown = unknownRecord(first);
  const left = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  const right = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await left.create(key, first), true);
  const outcomes = await Promise.all([
    left.compareAndSwap(key, 1, running),
    right.compareAndSwap(key, 1, unknown),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  const current = await left.load(key);
  assert.equal(current.revision, 2);
  assert.equal(current.observation.state, outcomes[0] ? 'running' : 'unknown');
});

test('orphan temporary files are ignored but unknown entries fail closed', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await store.create(key, acceptedRecord()), true);
  const directory = await keyDirectory(root);
  await writeFile(path.join(directory, `.tmp-${randomUUID()}.json`), '{partial', 'utf8');
  assert.equal((await store.load(key)).revision, 1);
  await writeFile(path.join(directory, 'unexpected.txt'), 'x', 'utf8');
  await assert.rejects(() => store.load(key), /unexpected entry/u);
});

test('temporary namespace entries must be regular files', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await store.create(key, acceptedRecord()), true);
  const directory = await keyDirectory(root);
  await mkdir(path.join(directory, `.tmp-${randomUUID()}.json`));
  await assert.rejects(() => store.load(key), /invalid temporary entry/u);
});

test('tampered or malformed immutable revision fails closed', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await store.create(key, acceptedRecord()), true);
  await writeFile(await revisionPath(root), '{"bad":true}\n', 'utf8');
  await assert.rejects(() => store.load(key), /revision is malformed/u);
});

test('revision gaps fail closed before a newer snapshot can be accepted', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await store.create(key, acceptedRecord()), true);
  const directory = await keyDirectory(root);
  await copyFile(await revisionPath(root), path.join(directory, '0000000000000003.json'));
  await assert.rejects(() => store.load(key), /history is not contiguous/u);
});

test('validly encoded but inconsistent revision history fails closed', async (t) => {
  const root = await tempRoot(t);
  const value = request();
  const key = acceleratorBrokerLedgerKey(value);
  const first = acceptedRecord(value);
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await store.create(key, first), true);
  const rejected = observation(value, ACCELERATOR_BROKER_STATE.REJECTED, { reason: ACCELERATOR_BROKER_REASON.BINDING_STALE });
  const inconsistent = { ...first, revision: 2, observation: rejected };
  await writeFile(path.join(await keyDirectory(root), '0000000000000002.json'), `${JSON.stringify(inconsistent)}\n`, 'utf8');
  await assert.rejects(() => store.load(key), /history is inconsistent/u);
});

test('oversized records are rejected before publication', async (t) => {
  const root = await tempRoot(t);
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root, maxRecordBytes: 128 });
  await assert.rejects(() => store.create(acceleratorBrokerLedgerKey(request()), acceptedRecord()), /record is oversized/u);
  const fanout = await readdir(root);
  assert.ok(fanout.length <= 1);
});

test('storage paths contain only opaque hashes and revision metadata, not guest identities', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await store.create(key, acceptedRecord()), true);
  const fanout = await readdir(root);
  const keys = await readdir(path.join(root, fanout[0]));
  const files = await readdir(path.join(root, fanout[0], keys[0]));
  const relative = JSON.stringify({ fanout, keys, files }).toLowerCase();
  for (const forbidden of ['broker-session-a', 'broker-session-generation-1', 'request-1']) {
    assert.equal(relative.includes(forbidden), false, forbidden);
  }
  assert.match(fanout[0], /^[0-9a-f]{2}$/u);
  assert.match(keys[0], /^[0-9a-f]{64}$/u);
});

test('record key mismatch and invalid ledger-key extensions are rejected before publication', async (t) => {
  const root = await tempRoot(t);
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  const wrongKey = normalizeAcceleratorBrokerLedgerKey({
    sessionIdentity: 'broker-session-a',
    sessionGeneration: 'broker-session-generation-1',
    requestId: 'request-other',
  });
  await assert.rejects(() => store.create(wrongKey, acceptedRecord()), /record key does not match/u);
  assert.throws(() => normalizeAcceleratorBrokerLedgerKey({ ...wrongKey, path: 'forbidden' }), /path is not allowed/u);
});

test('CAS requires the supplied record to be exactly expectedRevision plus one', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const first = acceptedRecord();
  const second = runningRecord(first);
  const invalidThird = { ...second, revision: 3 };
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await store.create(key, first), true);
  await assert.rejects(() => store.compareAndSwap(key, 1, invalidThird), /CAS record revision is invalid/u);
});

test('published revision is ordinary JSON and remains loadable after the writer temporary link is removed', async (t) => {
  const root = await tempRoot(t);
  const key = acceleratorBrokerLedgerKey(request());
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  assert.equal(await store.create(key, acceptedRecord()), true);
  const directory = await keyDirectory(root);
  const entries = await readdir(directory);
  assert.deepEqual(entries, ['0000000000000001.json']);
  const parsed = JSON.parse(await readFile(path.join(directory, entries[0]), 'utf8'));
  assert.equal(parsed.revision, 1);
  assert.equal((await store.load(key)).revision, 1);
});
