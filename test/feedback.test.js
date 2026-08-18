import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeedbackEnvelope } from '../src/github/feedback-envelope.js';
import { IssueFeedbackSource } from '../src/github/issue-feedback-source.js';

function block(value) {
  return `\`\`\`patch-poller-feedback\n${JSON.stringify(value)}\n\`\`\``;
}

const revision = 'a'.repeat(64);

test('parses context-linked continuation feedback', () => {
  const value = parseFeedbackEnvelope(block({
    protocol: 'patch-poller/feedback-v1',
    runId: 'run-1',
    taskRevision: revision,
    action: 'continue',
    instructions: 'Proceed with option B.'
  }));
  assert.equal(value.action, 'continue');
});

test('waiting feedback source ignores wrong actor and wrong run', async () => {
  const client = {
    request: async () => ({
      notModified: false,
      data: [
        { id: 10, user: { id: 999 }, body: block({ protocol: 'patch-poller/feedback-v1', runId: 'run-1', taskRevision: revision, action: 'cancel' }) },
        { id: 11, user: { id: 1775584 }, body: block({ protocol: 'patch-poller/feedback-v1', runId: 'old-run', taskRevision: revision, action: 'cancel' }) },
        { id: 12, user: { id: 1775584, login: 'iteathen' }, body: block({ protocol: 'patch-poller/feedback-v1', runId: 'run-1', taskRevision: revision, action: 'continue', instructions: 'Continue.' }) }
      ]
    })
  };
  const source = new IssueFeedbackSource({ client, queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'] });
  const result = await source.pollWaitingRun({ issueNumber: 4, runId: 'run-1', taskRevision: revision });
  assert.equal(result.feedback.commentId, 12);
  assert.equal(result.feedback.instructions, 'Continue.');
});
