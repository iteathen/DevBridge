import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueTaskSource } from '../src/github/issue-task-source.js';

const envelope = `\`\`\`patch-poller-task\n${JSON.stringify({ protocol: 'patch-poller/task-v1', target: { repository: 'iteathen/repo' }, instructions: 'Do work.' })}\n\`\`\``;

function provenanceNode({ nodeId, body, actorId = 1775584, editorId = null }) {
  const edited = editorId != null;
  const edit = edited ? { id: `${nodeId}-edit`, editedAt: '2026-08-18T20:00:00Z', deletedAt: null, deletedBy: null, editor: { databaseId: editorId, login: editorId === 1775584 ? 'iteathen' : 'bad' } } : null;
  return {
    __typename: 'Issue', id: nodeId, body,
    author: { databaseId: actorId, login: actorId === 1775584 ? 'iteathen' : 'bad' },
    editor: edited ? edit.editor : null,
    includesCreatedEdit: edited,
    lastEditedAt: edit?.editedAt ?? null,
    userContentEdits: { totalCount: edited ? 1 : 0, pageInfo: { hasNextPage: false }, nodes: edit ? [edit] : [] },
  };
}

test('accepts only exact-provenance trusted issue content and ignores pull requests', async () => {
  const issues = [
    { id: 1, node_id: 'I_good', number: 1, title: 'good', body: envelope, user: { id: 1775584, login: 'iteathen' } },
    { id: 2, node_id: 'I_bad', number: 2, title: 'bad', body: envelope, user: { id: 999, login: 'bad' } },
    { id: 3, node_id: 'I_pr', number: 3, title: 'pr', body: envelope, user: { id: 1775584 }, pull_request: {} },
  ];
  const client = {
    rateBudget: { snapshot: () => ({ pollIntervalMs: 60_000 }) },
    request: async (method, endpoint, options) => {
      if (method === 'GET') return { notModified: false, data: issues };
      assert.equal(endpoint, '/graphql');
      const id = options.body.variables.id;
      return { data: { data: { node: provenanceNode({ nodeId: id, body: envelope }) } } };
    },
  };
  const source = new IssueTaskSource({ client, queueRepository: 'iteathen/PATCH-POLLER', taskLabel: 'patch-poller:ready', trustedActorIds: ['1775584'] });
  const result = await source.poll();
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].issueNumber, 1);
  assert.match(result.tasks[0].revision, /^[0-9a-f]{64}$/u);
  assert.equal(result.tasks[0].authorityProvenance.creatorId, '1775584');
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'untrusted-actor');
});

test('trusted creator with an untrusted current editor is rejected as machine input', async () => {
  const issue = { id: 1, node_id: 'I_edited', number: 1, title: 'edited', body: envelope, user: { id: 1775584, login: 'iteathen' } };
  const client = {
    rateBudget: { snapshot: () => ({ pollIntervalMs: 60_000 }) },
    request: async (method) => method === 'GET'
      ? { notModified: false, data: [issue] }
      : { data: { data: { node: provenanceNode({ nodeId: issue.node_id, body: envelope, editorId: 999 }) } } },
  };
  const source = new IssueTaskSource({ client, queueRepository: 'iteathen/PATCH-POLLER', taskLabel: 'patch-poller:ready', trustedActorIds: ['1775584'] });
  const result = await source.poll();
  assert.equal(result.tasks.length, 0);
  assert.equal(result.rejected[0].reason, 'unverifiable-content-provenance');
  assert.match(result.rejected[0].detail, /not trusted/u);
});
