import { copyFile, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
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
} from '../src/runtime/accelerator-broker-ledger.js';
import {
  createAcceleratorBrokerGenerationObservation,
  normalizeAcceleratorBrokerGenerationObservation,
  normalizeAcceleratorBrokerGenerationSelector,
} from '../src/runtime/accelerator-broker-generation-catalog.js';
import { FileAcceleratorBrokerLedgerStore } from '../src/runtime/accelerator-broker-file-ledger.js';
import { FileAcceleratorBrokerGenerationCatalog } from '../src/runtime/accelerator-broker-file-ledger-catalog.js';

function request({
  requestId = 'request-1',
  executionId = `execution-${requestId}`,
  sessionIdentity = 'broker-session-a',
  sessionGeneration = 'broker-session-generation-1',
} = {}) {
  return {
    protocol: ACCELERATOR_BROKER_EXECUTE_PROTOCOL,
    requestId,
    executionId,
    binding: {
      profile: 'profile.cuda',
      environment: { identity: 'environment.cuda', generation: 'environment-generation-1' },
      backend: { subject: 'accelerator-backend-a', generation: 'backend-generation-1' },
      session: { identity: sessionIdentity, generation: sessionGeneration },
    },
    api: 'cuda',
    topology: 'host-retained',
    operation: ACCELERATOR_BROKER_OPERATION.CUDA_CANARY_U32_ADD_V1,
    input: { left: [1, 0xffff_ffff], right: [2, 1] },
  };
}

function stateFields(state) {
  if (state === ACCELERATOR_BROKER_STATE.SUCCEEDED) return { reason: null, result: { values: [3, 0] } };
  if (state === ACCELERATOR_BROKER_STATE.FAILED) return { reason: ACCELERATOR_BROKER_REASON.EXECUTION_FAILED, result: null };
  if (state === ACCELERATOR_BROKER_STATE.CANCELLED) return { reason: ACCELERATOR_BROKER_REASON.EXECUTION_CANCELLED, result: null };
  if (state === ACCELERATOR_BROKER_STATE.UNKNOWN) return { reason: ACCELERATOR_BROKER_REASON.STATE_UNKNOWN, result: null };
  if (state === ACCELERATOR_BROKER_STATE.REJECTED) return { reason: ACCELERATOR_BROKER_REASON.BACKEND_UNAVAILABLE, result: null };
  return { reason: null, result: null };
}

function observation(value, state) {
  return createAcceleratorBrokerObservation({
    requestId: value.requestId,
    executionId: value.executionId,
    requestDigest: digestAcceleratorBrokerExecuteRequest(value),
    binding: value.binding,
    api: value.api,
    topology: value.topology,
    operation: value.operation,
    state,
    ...stateFields(state),
  });
}

function record(value, state) {
  if (state === ACCELERATOR_BROKER_STATE.REJECTED) {
    return createAcceleratorBrokerLedgerRecord({ request: value, observation: observation(value, state) });
  }
  const accepted = createAcceleratorBrokerLedgerRecord({
    request: value,
    observation: observation(value, ACCELERATOR_BROKER_STATE.ACCEPTED),
  });
  if (state === ACCELERATOR_BROKER_STATE.ACCEPTED) return accepted;
  return advanceAcceleratorBrokerLedgerRecord(accepted, { observation: observation(value, state) });
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-accelerator-generation-catalog-'));
  const canonicalRoot = await realpath(root);
  t.after(() => rm(canonicalRoot, { recursive: true, force: true }));
  return canonicalRoot;
}

async function persist(store, value, state) {
  const current = record(value, state);
  const key = acceleratorBrokerLedgerKey(value);
  const first = current.revision === 1
    ? current
    : createAcceleratorBrokerLedgerRecord({ request: value, observation: observation(value, ACCELERATOR_BROKER_STATE.ACCEPTED) });
  assert.equal(await store.create(key, first), true);
  if (current.revision > 1) assert.equal(await store.compareAndSwap(key, 1, current), true);
}

async function onlyKeyDirectory(root) {
  const fanout = await readdir(root);
  assert.equal(fanout.length, 1);
  const fanoutPath = path.join(root, fanout[0]);
  const keys = await readdir(fanoutPath);
  assert.equal(keys.length, 1);
  return path.join(fanoutPath, keys[0]);
}

test('generation selector and observation reject extensions and inconsistent counts', () => {
  const selector = normalizeAcceleratorBrokerGenerationSelector({
    sessionIdentity: 'broker-session-a',
    sessionGeneration: 'broker-session-generation-1',
  });
  assert.deepEqual(selector, {
    sessionIdentity: 'broker-session-a',
    sessionGeneration: 'broker-session-generation-1',
  });
  assert.throws(() => normalizeAcceleratorBrokerGenerationSelector({ ...selector, path: 'forbidden' }), /path is not allowed/u);
  assert.throws(() => normalizeAcceleratorBrokerGenerationObservation({
    protocol: 'devbridge/accelerator-broker-generation-observation-v1',
    session: { identity: selector.sessionIdentity, generation: selector.sessionGeneration },
    recordCount: 1,
    terminalCount: 1,
    nonterminalCount: 1,
    quiescent: false,
  }), /counts are inconsistent/u);
});

test('logical generation observation counts exact terminal and nonterminal states without projecting records', () => {
  const states = [
    ACCELERATOR_BROKER_STATE.ACCEPTED,
    ACCELERATOR_BROKER_STATE.RUNNING,
    ACCELERATOR_BROKER_STATE.UNKNOWN,
    ACCELERATOR_BROKER_STATE.SUCCEEDED,
    ACCELERATOR_BROKER_STATE.FAILED,
    ACCELERATOR_BROKER_STATE.CANCELLED,
    ACCELERATOR_BROKER_STATE.REJECTED,
  ];
  const records = states.map((state, index) => record(request({ requestId: `request-${index + 1}` }), state));
  records.push(record(request({ requestId: 'other-generation', sessionGeneration: 'broker-session-generation-2' }), ACCELERATOR_BROKER_STATE.RUNNING));
  const observed = createAcceleratorBrokerGenerationObservation({
    sessionIdentity: 'broker-session-a',
    sessionGeneration: 'broker-session-generation-1',
  }, records);
  assert.deepEqual(observed, {
    protocol: 'devbridge/accelerator-broker-generation-observation-v1',
    session: { identity: 'broker-session-a', generation: 'broker-session-generation-1' },
    recordCount: 7,
    terminalCount: 4,
    nonterminalCount: 3,
    quiescent: false,
  });
  assert.equal(JSON.stringify(observed).includes('request-1'), false);
  assert.equal(JSON.stringify(observed).includes('accelerator-backend-a'), false);
});

test('file generation catalog proves empty generation quiescent and reproduces durable observation after restart', async (t) => {
  const root = await tempRoot(t);
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  const catalog = new FileAcceleratorBrokerGenerationCatalog({ rootPath: root });
  const selector = { sessionIdentity: 'broker-session-a', sessionGeneration: 'broker-session-generation-1' };
  assert.deepEqual(await catalog.observeGeneration(selector), {
    protocol: 'devbridge/accelerator-broker-generation-observation-v1',
    session: { identity: selector.sessionIdentity, generation: selector.sessionGeneration },
    recordCount: 0,
    terminalCount: 0,
    nonterminalCount: 0,
    quiescent: true,
  });

  await persist(store, request({ requestId: 'request-running' }), ACCELERATOR_BROKER_STATE.RUNNING);
  await persist(store, request({ requestId: 'request-succeeded' }), ACCELERATOR_BROKER_STATE.SUCCEEDED);
  await persist(store, request({ requestId: 'request-other', sessionGeneration: 'broker-session-generation-2' }), ACCELERATOR_BROKER_STATE.RUNNING);
  const observed = await catalog.observeGeneration(selector);
  assert.equal(observed.recordCount, 2);
  assert.equal(observed.terminalCount, 1);
  assert.equal(observed.nonterminalCount, 1);
  assert.equal(observed.quiescent, false);

  const reopened = new FileAcceleratorBrokerGenerationCatalog({ rootPath: root });
  assert.deepEqual(await reopened.observeGeneration(selector), observed);
  const projected = JSON.stringify(observed);
  assert.equal(projected.includes(root), false);
  assert.equal(projected.includes('accelerator-backend-a'), false);
});

test('file generation catalog ignores other exact generations without treating them as selected live effects', async (t) => {
  const root = await tempRoot(t);
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  await persist(store, request({ requestId: 'old-running', sessionGeneration: 'broker-session-generation-1' }), ACCELERATOR_BROKER_STATE.RUNNING);
  await persist(store, request({ requestId: 'new-succeeded', sessionGeneration: 'broker-session-generation-2' }), ACCELERATOR_BROKER_STATE.SUCCEEDED);
  const catalog = new FileAcceleratorBrokerGenerationCatalog({ rootPath: root });
  const observed = await catalog.observeGeneration({
    sessionIdentity: 'broker-session-a',
    sessionGeneration: 'broker-session-generation-2',
  });
  assert.equal(observed.recordCount, 1);
  assert.equal(observed.terminalCount, 1);
  assert.equal(observed.nonterminalCount, 0);
  assert.equal(observed.quiescent, true);
});

test('catalog fails closed on gapped immutable history instead of claiming quiescence', async (t) => {
  const root = await tempRoot(t);
  const value = request({ requestId: 'request-gap' });
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  await persist(store, value, ACCELERATOR_BROKER_STATE.ACCEPTED);
  const directory = await onlyKeyDirectory(root);
  await copyFile(path.join(directory, '0000000000000001.json'), path.join(directory, '0000000000000003.json'));
  const catalog = new FileAcceleratorBrokerGenerationCatalog({ rootPath: root });
  await assert.rejects(() => catalog.observeGeneration({
    sessionIdentity: value.binding.session.identity,
    sessionGeneration: value.binding.session.generation,
  }), /history is not contiguous/u);
});

test('catalog fails closed when a valid record directory is moved outside the ledger store owned layout', async (t) => {
  const root = await tempRoot(t);
  const value = request({ requestId: 'request-layout' });
  const store = new FileAcceleratorBrokerLedgerStore({ rootPath: root });
  await persist(store, value, ACCELERATOR_BROKER_STATE.ACCEPTED);
  const directory = await onlyKeyDirectory(root);
  const name = path.basename(directory);
  const replacementName = `${name.slice(0, -1)}${name.endsWith('0') ? '1' : '0'}`;
  await rename(directory, path.join(path.dirname(directory), replacementName));
  const catalog = new FileAcceleratorBrokerGenerationCatalog({ rootPath: root });
  await assert.rejects(() => catalog.observeGeneration({
    sessionIdentity: value.binding.session.identity,
    sessionGeneration: value.binding.session.generation,
  }), /outside the store-owned layout/u);
});

test('catalog fails closed on unexpected root namespace entries', async (t) => {
  const root = await tempRoot(t);
  await writeFile(path.join(root, 'unexpected.txt'), 'x', 'utf8');
  const catalog = new FileAcceleratorBrokerGenerationCatalog({ rootPath: root });
  await assert.rejects(() => catalog.observeGeneration({
    sessionIdentity: 'broker-session-a',
    sessionGeneration: 'broker-session-generation-1',
  }), /unexpected root entry/u);
});
