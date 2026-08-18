import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeedbackEnvelope } from '../src/github/feedback-envelope.js';
import { contentSha256 } from '../src/github/content-provenance.js';
import { IssueFeedbackSource } from '../src/github/issue-feedback-source.js';

function block(value) {
  return `\`\`\`patch-poller-feedback\n${JSON.stringify(value)}\n\`\`\``;
}

const revision = 'a'.repeat(64);

function feedbackValue(action = 'continue') {
  return {
    protocol: 'patch-poller/feedback-v1',
    runId: 'run-1',
    taskRevision: revision,
    action,
    ...(action === 'continue' ? { instructions: 'Continue.' } : {}),
  };
}

function verified(candidate) {
  return {
    verified: true,
    reason: null,
    nodeId: candidate.nodeId,
    expectedType: 'IssueComment',
    contentSha256: contentSha256(candidate.body),
    creatorActorId: String(candidate.authorId),
    creatorLogin: candidate.authorLogin ?? null,
    currentEditorActorId: null,
    editorActorIds: [],
    editCount: 0,
    redactedEditCount: 0,
    historyComplete: true,
    lastEditedAt: null,
  };
}

test('parses context-linked continuation feedback and digests the exact comment body', () => {
  const raw = block({
    protocol: 'patch-poller/feedback-v1',
    runId: 'run-1',
    taskRevision: revision,
    action: 'continue',
    instructions: 'Proceed with option B.'
  });
  const value = parseFeedbackEnvelope(raw);
  assert.equal(value.action, 'continue');
  assert.equal(value.contentSha256, contentSha256(raw));
  assert.notEqual(parseFeedbackEnvelope(`${raw}\nadditional discussion`).contentSha256, value.contentSha256);
});

test('quoted feedback envelope is ordinary discussion rather than authority', () => {
  const quoted = block(feedbackValue()).split('\n').map((line) => `> ${line}`).join('\n');
  assert.throws(() => parseFeedbackEnvelope(quoted), /exactly one/u);
});

test('waiting feedback source ignores wrong actor and wrong run, then accepts exact trusted provenance', async () => {
  const comments = [
    { id: 10, node_id: 'IC_10', user: { id: 999 }, body: block({ protocol: 'patch-poller/feedback-v1', runId: 'run-1', taskRevision: revision, action: 'cancel' }) },
    { id: 11, node_id: 'IC_11', user: { id: 1775584 }, body: block({ protocol: 'patch-poller/feedback-v1', runId: 'old-run', taskRevision: revision, action: 'cancel' }) },
    { id: 12, node_id: 'IC_12', user: { id: 1775584, login: 'iteathen' }, body: block(feedbackValue()) }
  ];
  const client = { request: async () => ({ notModified: false, data: comments }) };
  const contentProvenance = { verifyMany: async (candidates) => candidates.map(verified) };
  const source = new IssueFeedbackSource({
    client,
    queueRepository: 'iteathen/PATCH-POLLER',
    trustedActorIds: ['1775584'],
    contentProvenance,
  });
  const result = await source.pollWaitingRun({ issueNumber: 4, runId: 'run-1', taskRevision: revision });
  assert.equal(result.feedback.commentId, 12);
  assert.equal(result.feedback.instructions, 'Continue.');
  assert.equal(result.feedback.provenance.verified, true);
  assert.equal(result.feedback.contentSha256, contentSha256(comments[2].body));
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].commentId, 10);
  assert.equal(result.rejected[0].reason, 'untrusted-creator');
});

test('trusted comment author plus untrusted edit provenance cannot resume a run', async () => {
  const comment = { id: 20, node_id: 'IC_20', user: { id: 1775584, login: 'iteathen' }, body: block(feedbackValue()) };
  const source = new IssueFeedbackSource({
    client: { request: async () => ({ notModified: false, data: [comment] }) },
    queueRepository: 'iteathen/PATCH-POLLER',
    trustedActorIds: ['1775584'],
    contentProvenance: {
      verifyMany: async ([candidate]) => [{
        ...verified(candidate),
        verified: false,
        reason: 'untrusted-editor',
        currentEditorActorId: '999',
        editorActorIds: ['999'],
        editCount: 2,
        historyComplete: true,
      }],
    },
  });
  const result = await source.pollWaitingRun({ issueNumber: 4, runId: 'run-1', taskRevision: revision });
  assert.equal(result.feedback, null);
  assert.equal(result.highestCommentId, 20);
  assert.equal(result.rejected[0].reason, 'untrusted-editor');
  assert.equal(result.rejected[0].provenance.currentEditorActorId, '999');
});

test('provenance infrastructure failure does not advance the feedback cursor and forces a REST retry', async () => {
  let invalidated = null;
  const comment = { id: 30, node_id: 'IC_30', user: { id: 1775584, login: 'iteathen' }, body: block(feedbackValue()) };
  const source = new IssueFeedbackSource({
    client: {
      request: async () => ({ notModified: false, data: [comment] }),
      invalidateConditional: async (requestPath) => { invalidated = requestPath; },
    },
    queueRepository: 'iteathen/PATCH-POLLER',
    trustedActorIds: ['1775584'],
    contentProvenance: { verifyMany: async () => { throw new Error('GraphQL temporarily unavailable'); } },
  });
  const result = await source.pollWaitingRun({ issueNumber: 4, runId: 'run-1', taskRevision: revision, afterCommentId: 7 });
  assert.equal(result.feedback, null);
  assert.equal(result.highestCommentId, 7);
  assert.equal(result.provenanceRetryRequired, true);
  assert.equal(result.rejected[0].reason, 'provenance-unavailable');
  assert.match(invalidated, /\/issues\/4\/comments\?per_page=100$/u);
});
