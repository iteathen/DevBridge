import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatHandoff, chatHandoffDigest } from '../src/context/chat-handoff.js';
import { ChatHandoffProjector, parseChatHandoffProjectionBody } from '../src/github/chat-handoff-projector.js';

function memoryStore() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? structuredClone(values.get(key)) : undefined; },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}

function fakeGitHub() {
  const comments = [];
  return {
    comments,
    async request(method, requestPath, options = {}) {
      if (method === 'GET') return { data: comments, headers: new Headers() };
      if (method === 'POST') {
        const item = { id: 77, body: options.body.body };
        comments.push(item);
        return { data: item, headers: new Headers() };
      }
      if (method === 'PATCH') {
        comments[0].body = options.body.body;
        return { data: comments[0], headers: new Headers() };
      }
      throw new Error(`unexpected request ${method} ${requestPath}`);
    },
  };
}

test('GitHub recovery seed keeps mailbox repository distinct from target repository', async () => {
  const handoff = buildChatHandoff({
    handoffId: 'cross-repo-mailbox',
    sequence: 1,
    repository: 'iteathen/TARGET-PROJECT',
    baselineSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    branch: 'feature/rollover',
    issueNumber: 20,
    prNumber: null,
    runId: null,
    phase: 'testing',
    completedActionIds: [],
    nextActionId: 'observe-target',
    decisions: [],
    blockers: [],
    evidenceRefs: [],
    governingDocs: [],
    previousHandoffDigest: null,
    createdAt: '2026-08-18T18:45:00.000Z',
  });
  const record = {
    protocol: 'patch-poller/chat-handoff-store-v1',
    state: 'ready',
    digest: chatHandoffDigest(handoff),
    handoff,
    createdAt: handoff.createdAt,
    verifiedAt: handoff.createdAt,
  };
  const client = fakeGitHub();
  const projector = new ChatHandoffProjector({ client, stateStore: memoryStore(), queueRepository: 'iteathen/PATCH-POLLER' });
  const projected = await projector.project({ issueNumber: 20, record });
  assert.ok(projected.seed.includes('mailbox=iteathen/PATCH-POLLER'));
  assert.ok(projected.seed.includes('repo=iteathen/TARGET-PROJECT'));
  const parsed = parseChatHandoffProjectionBody(client.comments[0].body);
  assert.equal(parsed.seed.mailboxRepository, 'iteathen/PATCH-POLLER');
  assert.equal(parsed.seed.repository, 'iteathen/TARGET-PROJECT');
  assert.equal(parsed.handoff.repository, 'iteathen/TARGET-PROJECT');
});
