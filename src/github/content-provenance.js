import { createHash } from 'node:crypto';
import { PolicyError } from '../errors.js';

const MAX_EDITS = 100;
const QUERY = `
query PatchPollerContentProvenance($id: ID!, $edits: Int!) {
  node(id: $id) {
    __typename
    ... on Issue {
      id body includesCreatedEdit lastEditedAt
      author { login ... on User { databaseId } }
      editor { login ... on User { databaseId } }
      userContentEdits(first: $edits) {
        totalCount pageInfo { hasNextPage }
        nodes { id editedAt deletedAt editor { login ... on User { databaseId } } deletedBy { login ... on User { databaseId } } }
      }
    }
    ... on IssueComment {
      id body includesCreatedEdit lastEditedAt
      author { login ... on User { databaseId } }
      editor { login ... on User { databaseId } }
      userContentEdits(first: $edits) {
        totalCount pageInfo { hasNextPage }
        nodes { id editedAt deletedAt editor { login ... on User { databaseId } } deletedBy { login ... on User { databaseId } } }
      }
    }
  }
}`;

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex');
}

function actor(actor) {
  return actor?.databaseId == null ? null : { id: String(actor.databaseId), login: actor.login ?? null };
}

function trustedActor(raw, trustedIds, label) {
  const value = actor(raw);
  if (!value) throw new PolicyError(`${label} edit provenance is unavailable`);
  if (!trustedIds.has(value.id)) throw new PolicyError(`${label} actor is not trusted`);
  return value;
}

export async function verifyContentProvenance({ client, nodeId, expectedBody, creatorId, trustedActorIds, expectedType }) {
  if (typeof nodeId !== 'string' || nodeId.length === 0) throw new PolicyError('GitHub node identity is required for content provenance');
  const trustedIds = trustedActorIds instanceof Set ? trustedActorIds : new Set([...trustedActorIds].map(String));
  const creator = String(creatorId ?? '');
  if (!trustedIds.has(creator)) throw new PolicyError('original content actor is not trusted');

  const response = await client.request('POST', '/graphql', { body: { query: QUERY, variables: { id: nodeId, edits: MAX_EDITS } } });
  if (response.data?.errors?.length) throw new PolicyError('GitHub edit provenance query failed');
  const observed = response.data?.data?.node;
  if (!observed || observed.__typename !== expectedType) throw new PolicyError('GitHub content provenance node is missing or has the wrong type');
  if (observed.body !== expectedBody) throw new PolicyError('content changed between intake and provenance verification');

  const original = trustedActor(observed.author, trustedIds, 'original');
  if (original.id !== creator) throw new PolicyError('creator identity differs between REST intake and provenance verification');
  const history = observed.userContentEdits;
  if (!history || !Array.isArray(history.nodes) || !Number.isInteger(history.totalCount) || !history.pageInfo) throw new PolicyError('GitHub edit provenance is unavailable');
  if (history.totalCount > MAX_EDITS || history.pageInfo.hasNextPage === true || history.nodes.length !== history.totalCount) throw new PolicyError('GitHub edit provenance is truncated');

  const edited = observed.lastEditedAt != null;
  if (edited && observed.includesCreatedEdit !== true) throw new PolicyError('edited content lacks complete creation/edit provenance');
  if (!edited && (history.totalCount !== 0 || observed.editor != null)) throw new PolicyError('GitHub edit provenance is internally inconsistent');

  const edits = history.nodes.map((entry) => {
    if (entry?.deletedAt != null || entry?.deletedBy != null) throw new PolicyError('edit provenance contains deleted or ambiguous metadata');
    if (typeof entry?.id !== 'string' || typeof entry?.editedAt !== 'string') throw new PolicyError('edit provenance is incomplete');
    const editor = trustedActor(entry.editor, trustedIds, 'edit');
    return { id: entry.id, editedAt: entry.editedAt, editorId: editor.id, editorLogin: editor.login };
  });
  const latest = edited ? trustedActor(observed.editor, trustedIds, 'latest editor') : null;
  if (edited && edits.length === 0) throw new PolicyError('edited content has no verifiable edit records');

  const normalized = {
    protocol: 'patch-poller/content-provenance-v1', nodeId, nodeType: observed.__typename,
    contentSha256: sha256(expectedBody), creatorId: original.id, creatorLogin: original.login,
    edited, lastEditedAt: observed.lastEditedAt ?? null, latestEditorId: latest?.id ?? null,
    latestEditorLogin: latest?.login ?? null, edits,
  };
  return { ...normalized, provenanceSha256: sha256(normalized) };
}

export function bindRevision(envelopeRevision, provenance) {
  if (!/^[0-9a-f]{64}$/u.test(envelopeRevision ?? '') || !/^[0-9a-f]{64}$/u.test(provenance?.provenanceSha256 ?? '')) throw new PolicyError('revision binding requires verified SHA-256 identities');
  return sha256({ envelopeRevision, contentSha256: provenance.contentSha256, provenanceSha256: provenance.provenanceSha256 });
}

export const contentProvenanceQueryForTests = QUERY;
