import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatHandoff, chatHandoffDigest, reconcileChatResume } from '../src/context/chat-handoff.js';
import {
  ChatHandoffProjector,
  parseChatHandoffProjectionBody,
  parseGitHubChatResumeSeed,
} from '../src/github/chat-handoff-projector.js';

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}

function record(sequence, overrides = {}) {
  const handoff = buildChatHandoff({
    handoffId: `projection-${sequence}`,
    sequence,
    repository: 'iteathen/DevBridge',
    baselineSha: 'a'.repeat(40),
    headSha: sequence === 1 ? 'b'.repeat(40) : 'c'.repeat(40),
    branch: 'sol/pp-014-context-rollover',
    issueNumber: 20,
    prNumber: 21,
    runId: 'pp014-projection',
    phase: 'testing',
    completedActionIds: sequence === 1 ? ['implement'] : ['implement', 'test'],
    nextActionId: sequence === 1 ? 'test' : 'merge',
    decisions: [],
    blockers: [],
    evidenceRefs: [],
    governingDocs: [],
    previousHandoffDigest: null,
    createdAt: `2026-08-18T18:2${sequence}:00.000Z`,
    ...overrides,
  });
  return { protocol: 'devbridge/chat-handoff-store-v1', state: 'ready', digest: chatHandoffDigest(handoff), handoff, createdAt: handoff.createdAt, verifiedAt: handoff.createdAt };
}

function fakeGitHub() {
  const comments = [];
  const calls = [];
  let nextId = 900;
  return {
    comments,
    calls,
    async request(method, requestPath, options = {}) {
      calls.push({ method, requestPath, options });
      if (method === 'GET') return { data: comments.map((item) => ({ ...item })), headers: new Headers() };
      if (method === 'POST') {
        const item = { id: nextId++, body: options.body.body };
        comments.push(item);
        return { data: { ...item }, headers: new Headers() };
      }
      if (method === 'PATCH') {
        const id = Number.parseInt(requestPath.split('/').at(-1), 10);
        const item = comments.find((candidate) => candidate.id === id);
        if (!item) { const error = new Error('not found'); error.status = 404; throw error; }
        item.body = options.body.body;
        return { data: { ...item }, headers: new Headers() };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

test('GitHub projection creates one bounded recovery comment and then edits it for later checkpoints', async () => {
  const client = fakeGitHub();
  const projector = new ChatHandoffProjector({
    client,
    stateStore: memoryStore(),
    queueRepository: 'iteathen/DevBridge',
    maxCommentBytes: 48_000,
  });
  const first = await projector.project({ issueNumber: 20, record: record(1) });
  assert.equal(first.projected, true);
  assert.equal(client.comments.length, 1);
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(client.comments[0].body.includes('DevBridge — CHAT HANDOFF READY'));
  const parsed = parseGitHubChatResumeSeed(first.seed);
  assert.equal(parsed.issueNumber, 20);
  assert.equal(parsed.repository, 'iteathen/DevBridge');

  const second = await projector.project({ issueNumber: 20, record: record(2) });
  assert.equal(second.commentId, first.commentId);
  assert.equal(client.comments.length, 1, 'later checkpoints must edit rather than append recovery comments');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(client.calls.filter((call) => call.method === 'PATCH').length, 1);
  assert.ok(client.comments[0].body.includes(record(2).digest));
});

test('projection reconciles a crash-after-create by finding its durable marker before posting again', async () => {
  const client = fakeGitHub();
  const firstState = memoryStore();
  const projector = new ChatHandoffProjector({ client, stateStore: firstState, queueRepository: 'iteathen/DevBridge' });
  const item = record(1);
  await projector.project({ issueNumber: 20, record: item });
  assert.equal(client.comments.length, 1);

  const restarted = new ChatHandoffProjector({ client, stateStore: memoryStore(), queueRepository: 'iteathen/DevBridge' });
  const recovered = await restarted.project({ issueNumber: 20, record: item });
  assert.equal(recovered.projected, true);
  assert.equal(client.comments.length, 1, 'marker reconciliation must not create a duplicate comment');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(client.calls.filter((call) => call.method === 'GET').length >= 2);
});

test('fresh controller can verify a GitHub projection and recover exactly the recorded phase and next action', async () => {
  const client = fakeGitHub();
  const projector = new ChatHandoffProjector({ client, stateStore: memoryStore(), queueRepository: 'iteathen/DevBridge' });
  const source = record(2);
  const projection = await projector.project({ issueNumber: 20, record: source });

  const fresh = parseChatHandoffProjectionBody(client.comments[0].body);
  assert.equal(fresh.digest, source.digest);
  assert.equal(fresh.handoff.phase, 'testing');
  assert.equal(fresh.seed.digest, source.digest);
  assert.equal(fresh.seed.issueNumber, 20);

  const reconciled = reconcileChatResume({
    handoff: fresh.handoff,
    observed: {
      repository: fresh.handoff.repository,
      baselineSha: fresh.handoff.baselineSha,
      headSha: fresh.handoff.headSha,
      issueNumber: fresh.handoff.issueNumber,
      prNumber: fresh.handoff.prNumber,
      runId: fresh.handoff.runId,
      completedActionIds: fresh.handoff.completedActionIds,
      governingDocs: fresh.handoff.governingDocs,
    },
  });
  assert.equal(reconciled.status, 'ready');
  assert.equal(reconciled.nextActionId, 'merge');
  assert.equal(projection.seed, client.comments[0].body.split(/\r?\n/u).find((line) => line.startsWith('DEVBRIDGE-RESUME-GITHUB v1 ')));
});

test('tampered GitHub projection is rejected before a fresh controller can resume it', async () => {
  const client = fakeGitHub();
  const projector = new ChatHandoffProjector({ client, stateStore: memoryStore(), queueRepository: 'iteathen/DevBridge' });
  await projector.project({ issueNumber: 20, record: record(1) });
  const tampered = client.comments[0].body.replace('"phase": "testing"', '"phase": "publishing"');
  assert.throws(() => parseChatHandoffProjectionBody(tampered), /digest mismatch/u);
});

test('projection fails closed instead of publishing a digest-divergent redacted handoff', async () => {
  const client = fakeGitHub();
  const projector = new ChatHandoffProjector({
    client,
    stateStore: memoryStore(),
    queueRepository: 'iteathen/DevBridge',
    maxCommentBytes: 48_000,
    secretValues: ['SUPER-SECRET-MARKER'],
  });
  const withSecret = record(1, { blockers: ['SUPER-SECRET-MARKER'] });
  await assert.rejects(() => projector.project({ issueNumber: 20, record: withSecret }), /requires redaction/u);
  assert.equal(client.comments.length, 0);
});

test('projection refuses a handoff larger than the remote comment budget', async () => {
  const tiny = new ChatHandoffProjector({ client: fakeGitHub(), stateStore: memoryStore(), queueRepository: 'iteathen/DevBridge', maxCommentBytes: 4096 });
  await assert.rejects(() => tiny.project({ issueNumber: 20, record: record(1, { blockers: ['x'.repeat(2000), 'y'.repeat(2000)] }) }), /comment budget/u);
});
