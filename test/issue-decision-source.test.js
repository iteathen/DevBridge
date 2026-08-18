import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueDecisionSource } from '../src/github/issue-decision-source.js';

const revision = 'a'.repeat(64);
const subject = 'b'.repeat(64);
const checkpoint = {
  runId: 'pp-9-aaaa',
  taskRevision: revision,
  checkpointId: 'gate-control-plane-fixture',
  subjectDigest: subject,
  decisionClass: 'control-plane',
  createdAt: '2026-08-18T12:00:00Z',
  expiresAt: '2026-08-19T12:00:00Z',
};

function body(action = 'approve') {
  return `\`\`\`patch-poller-decision\n${JSON.stringify({
    protocol: 'patch-poller/decision-v1',
    runId: checkpoint.runId,
    taskRevision: revision,
    checkpointId: checkpoint.checkpointId,
    subjectDigest: subject,
    action
  })}\n\`\`\``;
}

test('rejects decision replay from before checkpoint creation and accepts later exact trusted decision', async () => {
  const comments = [
    { id: 1, body: body(), user: { id: 1775584 }, created_at: '2026-08-18T11:59:59Z', updated_at: '2026-08-18T11:59:59Z' },
    { id: 2, body: body(), user: { id: 1775584 }, created_at: '2026-08-18T12:01:00Z', updated_at: '2026-08-18T12:02:00Z' },
    { id: 3, body: body(), user: { id: 999 }, created_at: '2026-08-18T12:03:00Z', updated_at: '2026-08-18T12:03:00Z' },
    { id: 4, body: body(), user: { id: 1775584, login: 'iteathen' }, created_at: '2026-08-18T12:04:00Z', updated_at: '2026-08-18T12:04:00Z' },
  ];
  const source = new IssueDecisionSource({
    client: { request: async () => ({ notModified: false, data: comments }) },
    queueRepository: 'iteathen/PATCH-POLLER',
    authorities: { 'control-plane': ['1775584'] }
  });
  const result = await source.pollCheckpoint({ issueNumber: 9, checkpoint, afterCommentId: 0, now: Date.parse('2026-08-18T12:05:00Z') });
  assert.equal(result.decision?.action, 'approve');
  assert.equal(result.decision?.commentId, 4);
  assert.equal(result.decision?.actorId, '1775584');
  assert.equal(result.decision?.authority.edited, false);
});

test('silence, quoted decisions, and mismatched subjects never authorize the gate', async () => {
  const wrong = body().replace(subject, 'c'.repeat(64));
  const comments = [
    { id: 5, body: `> ${body().replaceAll('\n', '\n> ')}`, user: { id: 1775584 }, created_at: '2026-08-18T12:05:00Z', updated_at: '2026-08-18T12:05:00Z' },
    { id: 6, body: wrong, user: { id: 1775584 }, created_at: '2026-08-18T12:06:00Z', updated_at: '2026-08-18T12:06:00Z' },
  ];
  const source = new IssueDecisionSource({
    client: { request: async () => ({ notModified: false, data: comments }) },
    queueRepository: 'iteathen/PATCH-POLLER',
    authorities: { 'control-plane': ['1775584'] }
  });
  const result = await source.pollCheckpoint({ issueNumber: 9, checkpoint, afterCommentId: 0, now: Date.parse('2026-08-18T12:07:00Z') });
  assert.equal(result.decision, null);
  assert.equal(result.reason, 'no-matching-decision');
});
