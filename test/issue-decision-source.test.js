import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueDecisionSource } from '../src/github/issue-decision-source.js';
import { contentSha256 } from '../src/github/content-provenance.js';

const taskRevision = 'a'.repeat(64);
const subjectDigest = 'b'.repeat(64);
const checkpointId = 'checkpoint-0123456789abcdef0123456789abcdef';
const TRUSTED = '1';
const OTHER = '2';

function block(overrides = {}) {
  return `\`\`\`devbridge-decision\n${JSON.stringify({
    protocol: 'devbridge/decision-v1',
    runId: 'run-1',
    taskRevision,
    checkpointId,
    subjectDigest,
    action: 'approve',
    ...overrides,
  })}\n\`\`\``;
}

function actor(id) {
  return { __typename: 'User', login: `u${id}`, databaseId: String(id) };
}

function uneditedNode(comment) {
  return {
    __typename: 'IssueComment',
    id: comment.node_id,
    body: comment.body,
    author: actor(comment.user.id),
    editor: null,
    lastEditedAt: null,
    includesCreatedEdit: false,
    userContentEdits: { totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] },
  };
}

function editedNode(comment, editorId) {
  return {
    __typename: 'IssueComment',
    id: comment.node_id,
    body: comment.body,
    author: actor(comment.user.id),
    editor: actor(editorId),
    lastEditedAt: '2026-08-18T23:30:00Z',
    includesCreatedEdit: true,
    userContentEdits: {
      totalCount: 2,
      pageInfo: { hasNextPage: false, hasPreviousPage: false },
      nodes: [
        { id: 'E0', editedAt: '2026-08-18T23:00:00Z', deletedAt: null, editor: actor(comment.user.id), deletedBy: null },
        { id: 'E1', editedAt: '2026-08-18T23:30:00Z', deletedAt: null, editor: actor(editorId), deletedBy: null },
      ],
    },
  };
}

function clientFor(comments, nodeFactory, { graphQlError = null, onInvalidate = null } = {}) {
  return {
    request: async () => ({ notModified: false, data: comments }),
    graphql: async (_query, variables) => {
      if (graphQlError) throw graphQlError;
      const byId = new Map(comments.map((comment) => [comment.node_id, comment]));
      return { data: { nodes: variables.ids.map((id) => nodeFactory(byId.get(id))) } };
    },
    invalidateConditional: onInvalidate ?? (async () => {}),
  };
}

test('returns only an exact matching class-authorized decision with verified edit provenance', async () => {
  const comment = { id: 10, node_id: 'IC_10', user: { id: Number(TRUSTED), login: 'trusted' }, body: block(), created_at: '2026-08-18T23:00:00Z' };
  const source = new IssueDecisionSource({ client: clientFor([comment], uneditedNode), queueRepository: 'owner/queue' });
  const result = await source.pollWaitingDecision({
    issueNumber: 27,
    runId: 'run-1',
    taskRevision,
    checkpointId,
    subjectDigest,
    authorizedActorIds: [TRUSTED],
  });
  assert.equal(result.decision.commentId, 10);
  assert.equal(result.decision.actorId, TRUSTED);
  assert.equal(result.decision.contentSha256, contentSha256(comment.body));
  assert.equal(result.decision.provenance.verified, true);
});

test('wrong actor, checkpoint, or subject cannot satisfy a pending gate', async () => {
  const comments = [
    { id: 11, node_id: 'IC_11', user: { id: Number(OTHER) }, body: block() },
    { id: 12, node_id: 'IC_12', user: { id: Number(TRUSTED) }, body: block({ checkpointId: 'checkpoint-other' }) },
    { id: 13, node_id: 'IC_13', user: { id: Number(TRUSTED) }, body: block({ subjectDigest: 'c'.repeat(64) }) },
  ];
  const source = new IssueDecisionSource({ client: clientFor(comments, uneditedNode), queueRepository: 'owner/queue' });
  const result = await source.pollWaitingDecision({
    issueNumber: 27,
    runId: 'run-1',
    taskRevision,
    checkpointId,
    subjectDigest,
    authorizedActorIds: [TRUSTED],
  });
  assert.equal(result.decision, null);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), [
    'decision-actor-unauthorized',
    'decision-checkpoint-mismatch',
    'decision-subject-mismatch',
  ]);
});

test('trusted original plus editor outside the class authority set fails provenance', async () => {
  const comment = { id: 14, node_id: 'IC_14', user: { id: Number(TRUSTED) }, body: block() };
  const source = new IssueDecisionSource({ client: clientFor([comment], (entry) => editedNode(entry, OTHER)), queueRepository: 'owner/queue' });
  const result = await source.pollWaitingDecision({
    issueNumber: 27,
    runId: 'run-1',
    taskRevision,
    checkpointId,
    subjectDigest,
    authorizedActorIds: [TRUSTED],
  });
  assert.equal(result.decision, null);
  assert.equal(result.rejected[0].reason, 'untrusted-current-editor');
  assert.equal(result.rejected[0].provenance.currentEditorActorId, OTHER);
});

test('decision provenance infrastructure failure does not advance the cursor', async () => {
  const comment = { id: 15, node_id: 'IC_15', user: { id: Number(TRUSTED) }, body: block() };
  let invalidated = null;
  const source = new IssueDecisionSource({
    client: clientFor([comment], uneditedNode, {
      graphQlError: new Error('GraphQL unavailable'),
      onInvalidate: async (requestPath) => { invalidated = requestPath; },
    }),
    queueRepository: 'owner/queue',
  });
  const result = await source.pollWaitingDecision({
    issueNumber: 27,
    runId: 'run-1',
    taskRevision,
    checkpointId,
    subjectDigest,
    authorizedActorIds: [TRUSTED],
    afterCommentId: 7,
  });
  assert.equal(result.decision, null);
  assert.equal(result.highestCommentId, 7);
  assert.equal(result.provenanceRetryRequired, true);
  assert.equal(result.rejected[0].reason, 'decision-provenance-unavailable');
  assert.match(invalidated, /\/issues\/27\/comments\?per_page=100$/u);
});
