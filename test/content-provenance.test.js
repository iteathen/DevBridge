import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubContentProvenance, MAX_RETAINED_CONTENT_EDITS, contentSha256 } from '../src/github/content-provenance.js';

const TRUSTED = '1775584';
const ALSO_TRUSTED = '1775585';
const UNTRUSTED = '999';
const BODY = '```devbridge-task\n{"protocol":"devbridge/task-v1"}\n```';

function actor(id, login = `u${id}`) {
  return { __typename: 'User', login, databaseId: String(id) };
}

function edit(id, actorId, editedAt, { deletedAt = null, editor = undefined } = {}) {
  return {
    id,
    editedAt,
    deletedAt,
    editor: editor === undefined ? actor(actorId) : editor,
    deletedBy: deletedAt == null ? null : actor(TRUSTED),
  };
}

function uneditedNode({ type = 'Issue', authorId = TRUSTED, body = BODY, nodeId = 'I_1' } = {}) {
  return {
    __typename: type,
    id: nodeId,
    body,
    author: actor(authorId),
    editor: null,
    lastEditedAt: null,
    includesCreatedEdit: false,
    userContentEdits: {
      totalCount: 0,
      pageInfo: { hasNextPage: false, hasPreviousPage: false },
      nodes: [],
    },
  };
}

function editedNode({
  type = 'Issue',
  authorId = TRUSTED,
  currentEditorId = ALSO_TRUSTED,
  body = BODY,
  nodeId = 'I_1',
  edits = null,
  includesCreatedEdit = true,
  lastEditedAt = '2026-08-18T22:00:00Z',
  totalCount = null,
  pageInfo = { hasNextPage: false, hasPreviousPage: false },
} = {}) {
  const history = edits ?? [
    edit('E_0', authorId, '2026-08-18T21:00:00Z'),
    edit('E_1', currentEditorId, lastEditedAt),
  ];
  return {
    __typename: type,
    id: nodeId,
    body,
    author: actor(authorId),
    editor: actor(currentEditorId),
    lastEditedAt,
    includesCreatedEdit,
    userContentEdits: {
      totalCount: totalCount ?? history.length,
      pageInfo,
      nodes: history,
    },
  };
}

function verifierFor(nodeOrNodes, trustedActorIds = [TRUSTED, ALSO_TRUSTED]) {
  const nodes = Array.isArray(nodeOrNodes) ? nodeOrNodes : [nodeOrNodes];
  return new GitHubContentProvenance({
    trustedActorIds,
    client: {
      graphql: async (_query, variables) => {
        assert.deepEqual(variables.ids, nodes.map((node) => node?.id ?? 'I_1'));
        return { data: { nodes } };
      },
    },
  });
}

function candidate({ type = 'Issue', authorId = TRUSTED, body = BODY, nodeId = 'I_1' } = {}) {
  return { nodeId, expectedType: type, body, authorId, authorLogin: `u${authorId}` };
}

test('unchanged trusted content is accepted and bound to exact bytes', async () => {
  const result = await verifierFor(uneditedNode()).verify(candidate());
  assert.equal(result.verified, true);
  assert.equal(result.contentSha256, contentSha256(BODY));
  assert.equal(result.creatorActorId, TRUSTED);
  assert.equal(result.editCount, 0);
  assert.equal(result.historyComplete, true);
});

test('trusted creator plus untrusted current editor is rejected', async () => {
  const node = editedNode({ currentEditorId: UNTRUSTED });
  const result = await verifierFor(node).verify(candidate());
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'untrusted-current-editor');
  assert.equal(result.currentEditorActorId, UNTRUSTED);
});

test('untrusted original cannot be laundered by a later trusted edit', async () => {
  const node = editedNode({ authorId: UNTRUSTED, currentEditorId: TRUSTED });
  const result = await verifierFor(node).verify(candidate({ authorId: UNTRUSTED }));
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'untrusted-creator');
});

test('all trusted multiple edits are accepted while one untrusted intermediate edit rejects authority', async () => {
  const trustedHistory = [
    edit('E_0', TRUSTED, '2026-08-18T20:00:00Z'),
    edit('E_1', ALSO_TRUSTED, '2026-08-18T21:00:00Z'),
    edit('E_2', TRUSTED, '2026-08-18T22:00:00Z'),
  ];
  const accepted = await verifierFor(editedNode({ currentEditorId: TRUSTED, edits: trustedHistory })).verify(candidate());
  assert.equal(accepted.verified, true);
  assert.deepEqual(accepted.editorActorIds.sort(), [ALSO_TRUSTED, TRUSTED].sort());

  const mixedHistory = [
    edit('E_0', TRUSTED, '2026-08-18T20:00:00Z'),
    edit('E_1', UNTRUSTED, '2026-08-18T21:00:00Z'),
    edit('E_2', TRUSTED, '2026-08-18T22:00:00Z'),
  ];
  const rejected = await verifierFor(editedNode({ currentEditorId: TRUSTED, edits: mixedHistory })).verify(candidate());
  assert.equal(rejected.verified, false);
  assert.equal(rejected.reason, 'untrusted-editor');
  assert.ok(rejected.editorActorIds.includes(UNTRUSTED));
});

test('redacted historical diff remains attributable when editor/time metadata is retained', async () => {
  const history = [
    edit('E_0', TRUSTED, '2026-08-18T20:00:00Z', { deletedAt: '2026-08-18T20:30:00Z' }),
    edit('E_1', ALSO_TRUSTED, '2026-08-18T22:00:00Z'),
  ];
  const result = await verifierFor(editedNode({ currentEditorId: ALSO_TRUSTED, edits: history })).verify(candidate());
  assert.equal(result.verified, true);
  assert.equal(result.redactedEditCount, 1);
});

test('deleted or missing editor metadata fails closed', async () => {
  const history = [
    edit('E_0', TRUSTED, '2026-08-18T20:00:00Z'),
    edit('E_1', TRUSTED, '2026-08-18T22:00:00Z', { editor: null }),
  ];
  const result = await verifierFor(editedNode({ currentEditorId: TRUSTED, edits: history })).verify(candidate());
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'provenance-edit-actor-missing');
});

test('a REST/GraphQL body race rejects the exact bytes being consumed', async () => {
  const node = uneditedNode({ body: `${BODY}\nchanged` });
  const result = await verifierFor(node).verify(candidate());
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'provenance-content-race');
  assert.equal(result.contentSha256, contentSha256(BODY));
  assert.equal(result.observedContentSha256, contentSha256(`${BODY}\nchanged`));
});

test('truncated and saturated edit history are rejected because provenance is incomplete', async () => {
  const truncated = editedNode({
    pageInfo: { hasNextPage: true, hasPreviousPage: false },
  });
  const truncatedResult = await verifierFor(truncated).verify(candidate());
  assert.equal(truncatedResult.verified, false);
  assert.equal(truncatedResult.reason, 'provenance-history-truncated');

  const saturatedHistory = Array.from({ length: MAX_RETAINED_CONTENT_EDITS }, (_value, index) =>
    edit(`E_${index}`, TRUSTED, index === MAX_RETAINED_CONTENT_EDITS - 1
      ? '2026-08-18T22:00:00Z'
      : `2026-08-18T20:${String(index % 60).padStart(2, '0')}:00Z`));
  const saturated = editedNode({
    currentEditorId: TRUSTED,
    edits: saturatedHistory,
    totalCount: MAX_RETAINED_CONTENT_EDITS,
  });
  const saturatedResult = await verifierFor(saturated).verify(candidate());
  assert.equal(saturatedResult.verified, false);
  assert.equal(saturatedResult.reason, 'provenance-history-saturated');
});

test('missing creation provenance or a mismatched final edit fails closed', async () => {
  const noCreation = editedNode({ includesCreatedEdit: false });
  const noCreationResult = await verifierFor(noCreation).verify(candidate());
  assert.equal(noCreationResult.verified, false);
  assert.equal(noCreationResult.reason, 'provenance-creation-history-missing');

  const mismatched = editedNode({
    currentEditorId: TRUSTED,
    edits: [
      edit('E_0', TRUSTED, '2026-08-18T20:00:00Z'),
      edit('E_1', TRUSTED, '2026-08-18T21:00:00Z'),
    ],
  });
  const mismatchResult = await verifierFor(mismatched).verify(candidate());
  assert.equal(mismatchResult.verified, false);
  assert.equal(mismatchResult.reason, 'provenance-current-revision-mismatch');
});

test('IssueComment uses the same exact-content provenance policy', async () => {
  const node = editedNode({ type: 'IssueComment', nodeId: 'IC_1', currentEditorId: TRUSTED });
  const result = await verifierFor(node).verify(candidate({ type: 'IssueComment', nodeId: 'IC_1' }));
  assert.equal(result.verified, true);
  assert.equal(result.expectedType, 'IssueComment');
});
