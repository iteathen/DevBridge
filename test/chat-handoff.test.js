import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_HANDOFF_PROTOCOL,
  ChatHandoffStore,
  buildChatHandoff,
  buildChatResumeSeed,
  chatHandoffDigest,
  normalizeChatHandoff,
  parseChatResumeSeed,
  reconcileChatResume,
} from '../src/context/chat-handoff.js';
import { PolicyError, ProtocolError } from '../src/errors.js';

const GIT_A = 'a'.repeat(40);
const GIT_B = 'b'.repeat(40);
const DOC_A = '1'.repeat(64);
const DOC_B = '2'.repeat(64);
const DECISION = '3'.repeat(64);

function handoff(overrides = {}) {
  return {
    protocol: CHAT_HANDOFF_PROTOCOL,
    handoffId: 'pp014-fixture-1',
    sequence: 1,
    repository: 'iteathen/DevBridge',
    baselineSha: GIT_A,
    headSha: GIT_B,
    branch: 'sol/pp-014-context-rollover',
    issueNumber: 20,
    prNumber: null,
    runId: 'pp-20-fixture',
    phase: 'implementing',
    completedActionIds: ['read-specs', 'create-branch'],
    nextActionId: 'implement-core',
    decisions: [{ id: 'architecture', digest: DECISION, summary: 'Use DB-005 plus DB-009 rather than a second effect journal.' }],
    blockers: [],
    evidenceRefs: [{ id: 'baseline', kind: 'commit', locator: `commit:${GIT_A}`, sha256: null }],
    governingDocs: [
      { path: 'AGENTS.md', sha256: DOC_A },
      { path: 'specs/DB-005-context-handoff.md', sha256: DOC_B },
    ],
    previousHandoffDigest: null,
    createdAt: '2026-08-18T18:00:00.000Z',
    ...overrides,
  };
}

function memoryStore() {
  const values = new Map();
  let failure = null;
  return {
    failWhen(predicate) { failure = predicate; },
    clearFailure() { failure = null; },
    corrupt(key, value) { values.set(key, structuredClone(value)); },
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
    async set(key, value) {
      if (failure?.(key, value)) throw new Error('injected state write failure');
      values.set(key, structuredClone(value));
    },
    async delete(key) { values.delete(key); },
    async entries(prefix = '') {
      return [...values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]);
    },
  };
}

function clock() {
  let tick = Date.parse('2026-08-18T18:00:00.000Z');
  return () => { const value = tick; tick += 1000; return value; };
}

test('chat handoff canonical digest is stable across object key ordering', () => {
  const first = handoff();
  const second = {
    createdAt: first.createdAt,
    previousHandoffDigest: first.previousHandoffDigest,
    governingDocs: [...first.governingDocs].reverse(),
    evidenceRefs: first.evidenceRefs,
    blockers: first.blockers,
    decisions: first.decisions,
    nextActionId: first.nextActionId,
    completedActionIds: [...first.completedActionIds].reverse(),
    phase: first.phase,
    runId: first.runId,
    prNumber: first.prNumber,
    issueNumber: first.issueNumber,
    branch: first.branch,
    headSha: first.headSha,
    baselineSha: first.baselineSha,
    repository: first.repository,
    sequence: first.sequence,
    handoffId: first.handoffId,
    protocol: first.protocol,
  };
  assert.deepEqual(normalizeChatHandoff(first), normalizeChatHandoff(second));
  assert.equal(chatHandoffDigest(first), chatHandoffDigest(second));
});

test('closed handoff schema rejects authority-shaped fields, local paths, and oversized payloads', () => {
  assert.throws(() => normalizeChatHandoff({ ...handoff(), executable: 'cmd.exe' }), /not allowed/u);
  assert.throws(() => normalizeChatHandoff({
    ...handoff(),
    evidenceRefs: [{ id: 'bad', kind: 'file', locator: 'C:/Users/example/secrets.txt', sha256: null }],
  }), ProtocolError);
  assert.throws(() => normalizeChatHandoff({ ...handoff(), blockers: Array.from({ length: 20 }, (_, index) => `${index}:${'x'.repeat(1990)}`) }), /byte ceiling/u);
});

test('two-phase checkpoint publishes a new ready pointer only after planned and ready readback verification', async () => {
  const stateStore = memoryStore();
  const store = new ChatHandoffStore({ stateStore, now: clock() });
  const first = await store.checkpoint(handoff());
  assert.equal(first.record.state, 'ready');
  assert.equal((await store.loadLatest('iteathen/DevBridge')).record.digest, first.record.digest);

  const secondHandoff = handoff({
    handoffId: 'pp014-fixture-2',
    sequence: 2,
    previousHandoffDigest: first.record.digest,
    completedActionIds: ['read-specs', 'create-branch', 'implement-core'],
    nextActionId: 'run-tests',
    createdAt: '2026-08-18T18:01:00.000Z',
  });
  stateStore.failWhen((key, value) => key.includes('.record.') && value?.state === 'ready' && value?.handoff?.sequence === 2);
  await assert.rejects(() => store.checkpoint(secondHandoff), /injected state write failure/u);
  stateStore.clearFailure();
  const latest = await store.loadLatest('iteathen/DevBridge');
  assert.equal(latest.record.digest, first.record.digest, 'failed replacement must not replace the prior verified handoff');
});

test('corrupt current handoff can fall back to the previous verified handoff', async () => {
  const stateStore = memoryStore();
  const store = new ChatHandoffStore({ stateStore, now: clock() });
  const first = await store.checkpoint(handoff());
  const second = await store.checkpoint(handoff({
    handoffId: 'pp014-fixture-2',
    sequence: 2,
    previousHandoffDigest: first.record.digest,
    nextActionId: 'run-tests',
    createdAt: '2026-08-18T18:01:00.000Z',
  }));
  stateStore.corrupt(second.ref.key, { protocol: 'corrupt', state: 'ready' });
  const recovered = await store.loadLatest('iteathen/DevBridge');
  assert.equal(recovered.recoveredFromPrevious, true);
  assert.equal(recovered.record.digest, first.record.digest);
});

test('checkpoint sequence and previous digest form a compare-and-swap boundary', async () => {
  const store = new ChatHandoffStore({ stateStore: memoryStore(), now: clock() });
  const first = await store.checkpoint(handoff());
  await assert.rejects(() => store.checkpoint(handoff({ handoffId: 'stale', nextActionId: 'other' })), PolicyError);
  await assert.rejects(() => store.checkpoint(handoff({
    handoffId: 'wrong-parent', sequence: 2, previousHandoffDigest: 'f'.repeat(64), createdAt: '2026-08-18T18:02:00.000Z',
  })), /previousHandoffDigest/u);
  const repeat = await store.checkpoint(handoff());
  assert.equal(repeat.idempotent, true);
  assert.equal(repeat.record.digest, first.record.digest);
});

test('resume seed is compact, digest-bound, and parseable without copying the handoff payload', () => {
  const normalized = buildChatHandoff(handoff(), { now: () => Date.parse('2026-08-18T18:00:00.000Z') });
  const digest = chatHandoffDigest(normalized);
  const seed = buildChatResumeSeed(normalized, digest);
  assert.ok(seed.length < 200);
  assert.deepEqual(parseChatResumeSeed(seed), {
    protocol: 'devbridge/chat-resume-seed-v1',
    repository: normalized.repository,
    handoffId: normalized.handoffId,
    digest,
  });
});

test('resume reconciliation blocks stale Git/task identity before exposing nextActionId', () => {
  const result = reconcileChatResume({
    handoff: handoff(),
    observed: {
      repository: 'iteathen/DevBridge',
      baselineSha: GIT_A,
      headSha: 'c'.repeat(40),
      issueNumber: 20,
      prNumber: null,
      runId: 'pp-20-fixture',
      completedActionIds: [],
      governingDocs: handoff().governingDocs,
    },
  });
  assert.equal(result.status, 'stale');
  assert.equal(result.nextActionId, null);
  assert.ok(result.mismatches.some((entry) => entry.field === 'headSha'));
});

test('governing document changes require reread acknowledgement before exact next action is released', () => {
  const changedDocs = [
    { path: 'AGENTS.md', sha256: '9'.repeat(64) },
    { path: 'specs/DB-005-context-handoff.md', sha256: DOC_B },
  ];
  const observed = {
    repository: 'iteathen/DevBridge', baselineSha: GIT_A, headSha: GIT_B, issueNumber: 20, prNumber: null,
    runId: 'pp-20-fixture', completedActionIds: [], governingDocs: changedDocs,
  };
  let result = reconcileChatResume({ handoff: handoff(), observed });
  assert.equal(result.status, 'reread-required');
  assert.deepEqual(result.mustReread, ['AGENTS.md']);
  assert.equal(result.nextActionId, null);
  result = reconcileChatResume({ handoff: handoff(), observed, acknowledgedRereadPaths: ['AGENTS.md'] });
  assert.equal(result.status, 'ready');
  assert.equal(result.nextActionId, 'implement-core');
});

test('already completed next action is reconciled without inventing a replacement action', () => {
  const result = reconcileChatResume({
    handoff: handoff(),
    observed: {
      repository: 'iteathen/DevBridge', baselineSha: GIT_A, headSha: GIT_B, issueNumber: 20, prNumber: null,
      runId: 'pp-20-fixture', completedActionIds: ['implement-core'], governingDocs: handoff().governingDocs,
    },
  });
  assert.equal(result.status, 'checkpoint-required');
  assert.equal(result.skippedCompletedActionId, 'implement-core');
  assert.equal(result.nextActionId, null);
  assert.equal(result.pendingNextActionId, null);
});
