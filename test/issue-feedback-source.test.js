import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueFeedbackSource } from '../src/github/issue-feedback-source.js';

const revision = 'a'.repeat(64);
const feedback = `\`\`\`patch-poller-feedback\n${JSON.stringify({
  protocol: 'patch-poller/feedback-v1',
  runId: 'pp-7-aaaa',
  taskRevision: revision,
  action: 'continue',
  instructions: 'Proceed with the bounded repair.'
})}\n\`\`\``;

function sourceFor(comments) {
  const client = { request: async () => ({ notModified: false, data: comments }) };
  return new IssueFeedbackSource({ client, queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'] });
}

test('accepts only trusted unedited exact feedback comments bound to the active run revision', async () => {
  const source = sourceFor([
    {
      id: 10,
      body: feedback,
      user: { id: 1775584, login: 'iteathen' },
      created_at: '2026-08-18T12:00:00Z',
      updated_at: '2026-08-18T12:00:00Z'
    }
  ]);
  const result = await source.pollWaitingRun({ issueNumber: 7, runId: 'pp-7-aaaa', taskRevision: revision });
  assert.equal(result.feedback.action, 'continue');
  assert.equal(result.feedback.commentId, 10);
  assert.equal(result.feedback.actorId, '1775584');
  assert.equal(result.feedback.authority.kind, 'github-issue-comment');
  assert.equal(result.feedback.authority.edited, false);
  assert.match(result.feedback.authority.bodySha256, /^[0-9a-f]{64}$/u);
});

test('edited, quoted, untrusted, and stale-revision feedback is discussion rather than authority', async () => {
  const stale = feedback.replace(revision, 'b'.repeat(64));
  const source = sourceFor([
    { id: 11, body: feedback, user: { id: 1775584 }, created_at: '2026-08-18T12:00:00Z', updated_at: '2026-08-18T12:01:00Z' },
    { id: 12, body: `> ${feedback.replaceAll('\n', '\n> ')}`, user: { id: 1775584 }, created_at: '2026-08-18T12:02:00Z', updated_at: '2026-08-18T12:02:00Z' },
    { id: 13, body: feedback, user: { id: 999 }, created_at: '2026-08-18T12:03:00Z', updated_at: '2026-08-18T12:03:00Z' },
    { id: 14, body: stale, user: { id: 1775584 }, created_at: '2026-08-18T12:04:00Z', updated_at: '2026-08-18T12:04:00Z' },
  ]);
  const result = await source.pollWaitingRun({ issueNumber: 7, runId: 'pp-7-aaaa', taskRevision: revision });
  assert.equal(result.feedback, null);
  assert.equal(result.highestCommentId, 14);
});
