import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRevision, verifyContentProvenance } from '../src/github/content-provenance.js';

const BODY = '```patch-poller-task\n{}\n```';
const TRUSTED = new Set(['1775584']);

function actor(id = 1775584, login = 'trusted') { return { databaseId: id, login }; }
function node(overrides = {}) {
  return {
    __typename: 'Issue',
    id: 'I_node',
    body: BODY,
    author: actor(),
    editor: null,
    includesCreatedEdit: false,
    lastEditedAt: null,
    userContentEdits: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
    ...overrides,
  };
}
function clientFor(observed) {
  return { request: async (method, endpoint) => {
    assert.equal(method, 'POST'); assert.equal(endpoint, '/graphql');
    return { data: { data: { node: observed } } };
  } };
}

async function verify(observed, overrides = {}) {
  return verifyContentProvenance({ client: clientFor(observed), nodeId: 'I_node', expectedBody: BODY, creatorId: '1775584', trustedActorIds: TRUSTED, expectedType: 'Issue', ...overrides });
}

test('unchanged trusted content binds exact bytes and stable provenance into replay revision', async () => {
  const provenance = await verify(node());
  assert.equal(provenance.creatorId, '1775584');
  assert.equal(provenance.edited, false);
  assert.match(provenance.contentSha256, /^[0-9a-f]{64}$/u);
  const envelopeRevision = 'a'.repeat(64);
  assert.equal(bindRevision(envelopeRevision, provenance), bindRevision(envelopeRevision, structuredClone(provenance)));
  const changed = await verify(node({ body: `${BODY}\nchanged` }), { expectedBody: `${BODY}\nchanged` });
  assert.notEqual(bindRevision(envelopeRevision, provenance), bindRevision(envelopeRevision, changed));
});

test('trusted creator plus untrusted editor is rejected', async () => {
  const edit = { id: 'edit-1', editedAt: '2026-08-18T20:00:00Z', deletedAt: null, deletedBy: null, editor: actor(999, 'untrusted') };
  await assert.rejects(() => verify(node({ editor: actor(999, 'untrusted'), includesCreatedEdit: true, lastEditedAt: edit.editedAt, userContentEdits: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [edit] } })), /not trusted/u);
});

test('untrusted creator cannot gain authority from a later trusted edit', async () => {
  const edit = { id: 'edit-1', editedAt: '2026-08-18T20:00:00Z', deletedAt: null, deletedBy: null, editor: actor() };
  await assert.rejects(() => verify(node({ author: actor(999, 'untrusted'), editor: actor(), includesCreatedEdit: true, lastEditedAt: edit.editedAt, userContentEdits: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [edit] } }), { creatorId: '999' }), /original content actor is not trusted/u);
});

test('multiple trusted edits are accepted only when the complete edit history is available', async () => {
  const edits = [
    { id: 'edit-1', editedAt: '2026-08-18T20:00:00Z', deletedAt: null, deletedBy: null, editor: actor() },
    { id: 'edit-2', editedAt: '2026-08-18T20:01:00Z', deletedAt: null, deletedBy: null, editor: actor() },
  ];
  const provenance = await verify(node({ editor: actor(), includesCreatedEdit: true, lastEditedAt: edits[1].editedAt, userContentEdits: { totalCount: 2, pageInfo: { hasNextPage: false }, nodes: edits } }));
  assert.equal(provenance.edits.length, 2);
  await assert.rejects(() => verify(node({ editor: actor(), includesCreatedEdit: true, lastEditedAt: edits[1].editedAt, userContentEdits: { totalCount: 101, pageInfo: { hasNextPage: true }, nodes: edits } })), /truncated/u);
});

test('deleted or missing edit metadata fails closed', async () => {
  const deleted = { id: 'edit-1', editedAt: '2026-08-18T20:00:00Z', deletedAt: '2026-08-18T20:02:00Z', deletedBy: actor(), editor: actor() };
  await assert.rejects(() => verify(node({ editor: actor(), includesCreatedEdit: true, lastEditedAt: deleted.editedAt, userContentEdits: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [deleted] } })), /deleted or ambiguous/u);
  await assert.rejects(() => verify(node({ editor: actor(), includesCreatedEdit: false, lastEditedAt: '2026-08-18T20:00:00Z' })), /lacks complete/u);
});

test('race between REST body and GraphQL current body is rejected', async () => {
  await assert.rejects(() => verify(node({ body: 'different current bytes' })), /changed between intake/u);
});
