import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeedbackEnvelope } from '../src/github/feedback-envelope.js';
import { parseDecisionEnvelope } from '../src/github/decision-envelope.js';
import { IssueFeedbackSource } from '../src/github/issue-feedback-source.js';

function feedbackBlock(value) {
  return `\`\`\`patch-poller-feedback\n${JSON.stringify(value)}\n\`\`\``;
}
function decisionBlock(value) {
  return `\`\`\`patch-poller-decision\n${JSON.stringify(value)}\n\`\`\``;
}
function comment(id, actorId, body, { edited = false } = {}) {
  return {
    id,
    user: { id: actorId, login: String(actorId) === '1775584' ? 'iteathen' : 'other' },
    body,
    created_at: '2026-08-18T20:00:00Z',
    updated_at: edited ? '2026-08-18T20:00:01Z' : '2026-08-18T20:00:00Z',
  };
}

const revision = 'a'.repeat(64);
const subjectDigest = 'b'.repeat(64);

test('parses standalone context-linked continuation feedback', () => {
  const value = parseFeedbackEnvelope(feedbackBlock({
    protocol: 'patch-poller/feedback-v1',
    runId: 'run-1',
    taskRevision: revision,
    action: 'continue',
    instructions: 'Proceed with option B.'
  }));
  assert.equal(value.action, 'continue');
  assert.throws(() => parseFeedbackEnvelope(`discussion\n${feedbackBlock({ protocol: 'patch-poller/feedback-v1', runId: 'run-1', taskRevision: revision, action: 'cancel' })}`), /standalone/u);
});

test('waiting feedback source ignores wrong actor, wrong run, and edited authority', async () => {
  const client = {
    request: async () => ({
      data: [
        comment(10, 999, feedbackBlock({ protocol: 'patch-poller/feedback-v1', runId: 'run-1', taskRevision: revision, action: 'cancel' })),
        comment(11, 1775584, feedbackBlock({ protocol: 'patch-poller/feedback-v1', runId: 'old-run', taskRevision: revision, action: 'cancel' })),
        comment(12, 1775584, feedbackBlock({ protocol: 'patch-poller/feedback-v1', runId: 'run-1', taskRevision: revision, action: 'cancel' }), { edited: true }),
        comment(13, 1775584, feedbackBlock({ protocol: 'patch-poller/feedback-v1', runId: 'run-1', taskRevision: revision, action: 'continue', instructions: 'Continue.' }))
      ]
    })
  };
  const source = new IssueFeedbackSource({ client, queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'] });
  const result = await source.pollWaitingRun({ issueNumber: 4, runId: 'run-1', taskRevision: revision });
  assert.equal(result.feedback.commentId, 13);
  assert.equal(result.feedback.instructions, 'Continue.');
  assert.equal(result.feedback.unedited, true);
  assert.match(result.feedback.contentSha256, /^[0-9a-f]{64}$/u);
});

test('parses bounded PP-007 decisions and requires redirect instructions', () => {
  const approved = parseDecisionEnvelope(decisionBlock({
    protocol: 'patch-poller/decision-v1', runId: 'run-1', taskRevision: revision,
    checkpointId: 'cp-1', subjectDigest, action: 'approve'
  }));
  assert.equal(approved.action, 'approve');
  assert.throws(() => parseDecisionEnvelope(decisionBlock({
    protocol: 'patch-poller/decision-v1', runId: 'run-1', taskRevision: revision,
    checkpointId: 'cp-1', subjectDigest, action: 'redirect'
  })), /requires instructions/u);
});

test('decision source requires trusted locally authorized unedited actor and exact bindings', async () => {
  const client = {
    request: async () => ({
      data: [
        comment(20, 1775584, decisionBlock({ protocol: 'patch-poller/decision-v1', runId: 'wrong', taskRevision: revision, checkpointId: 'cp-1', subjectDigest, action: 'approve' })),
        comment(21, 999, decisionBlock({ protocol: 'patch-poller/decision-v1', runId: 'run-1', taskRevision: revision, checkpointId: 'cp-1', subjectDigest, action: 'approve' })),
        comment(22, 1775584, decisionBlock({ protocol: 'patch-poller/decision-v1', runId: 'run-1', taskRevision: revision, checkpointId: 'cp-1', subjectDigest, action: 'approve' }), { edited: true }),
        comment(23, 1775584, decisionBlock({ protocol: 'patch-poller/decision-v1', runId: 'run-1', taskRevision: revision, checkpointId: 'cp-1', subjectDigest, action: 'approve' }))
      ]
    })
  };
  const source = new IssueFeedbackSource({ client, queueRepository: 'iteathen/PATCH-POLLER', trustedActorIds: ['1775584'] });
  const denied = await source.pollDecision({ issueNumber: 4, runId: 'run-1', taskRevision: revision, checkpointId: 'cp-1', subjectDigest, authorizedActorIds: ['1234'] });
  assert.equal(denied.decision, null);
  const accepted = await source.pollDecision({ issueNumber: 4, runId: 'run-1', taskRevision: revision, checkpointId: 'cp-1', subjectDigest, authorizedActorIds: ['1775584'] });
  assert.equal(accepted.decision.commentId, 23);
  assert.equal(accepted.decision.action, 'approve');
  assert.match(accepted.decision.contentSha256, /^[0-9a-f]{64}$/u);
});
