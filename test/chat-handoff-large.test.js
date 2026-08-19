import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_HANDOFF_PROTOCOL, ChatHandoffStore, parseChatResumeSeed, reconcileChatResume } from '../src/context/chat-handoff.js';

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async entries(prefix = '') { return [...values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]); },
  };
}

test('configured handoffs above the 32 KiB default remain seedable and resumable within the protocol ceiling', async () => {
  const store = new ChatHandoffStore({ stateStore: memoryStore(), maxBytes: 65_536, maxRetained: 8 });
  const handoff = {
    protocol: CHAT_HANDOFF_PROTOCOL,
    handoffId: 'large-configured-handoff',
    sequence: 1,
    repository: 'iteathen/DevBridge',
    baselineSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    branch: 'sol/pp-014-context-rollover',
    issueNumber: 20,
    prNumber: 21,
    runId: 'pp014-large-fixture',
    phase: 'testing',
    completedActionIds: ['large-evidence-compacted'],
    nextActionId: 'observe-ci',
    decisions: [],
    blockers: Array.from({ length: 20 }, (_, index) => `bounded-blocker-${index}-${'x'.repeat(1800)}`),
    evidenceRefs: [],
    governingDocs: [],
    previousHandoffDigest: null,
    createdAt: '2026-08-18T18:40:00.000Z',
  };
  const checkpoint = await store.checkpoint(handoff);
  const latest = await store.loadLatest('iteathen/DevBridge');
  assert.equal(latest.record.digest, checkpoint.record.digest);
  assert.equal(parseChatResumeSeed(latest.seed).digest, checkpoint.record.digest);
  const resumed = reconcileChatResume({
    handoff: latest.record.handoff,
    observed: {
      repository: handoff.repository,
      baselineSha: handoff.baselineSha,
      headSha: handoff.headSha,
      issueNumber: 20,
      prNumber: 21,
      runId: handoff.runId,
      completedActionIds: handoff.completedActionIds,
      governingDocs: [],
    },
  });
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.nextActionId, 'observe-ci');
});
