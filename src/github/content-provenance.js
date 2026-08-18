import { createHash } from 'node:crypto';
import { ProtocolError } from '../errors.js';

export const MAX_RETAINED_CONTENT_EDITS = 100;
const MAX_BATCH = 30;

const CONTENT_PROVENANCE_QUERY = `
query PatchPollerContentProvenance($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id
      body
      author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
      editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
      lastEditedAt
      includesCreatedEdit
      userContentEdits(first: 100) {
        totalCount
        pageInfo { hasNextPage hasPreviousPage }
        nodes {
          id
          editedAt
          deletedAt
          editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
          deletedBy { __typename login ... on User { databaseId } ... on Bot { databaseId } }
        }
      }
    }
    ... on IssueComment {
      id
      body
      author { __typename login ... on User { databaseId } ... on Bot { databaseId } }
      editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
      lastEditedAt
      includesCreatedEdit
      userContentEdits(first: 100) {
        totalCount
        pageInfo { hasNextPage hasPreviousPage }
        nodes {
          id
          editedAt
          deletedAt
          editor { __typename login ... on User { databaseId } ... on Bot { databaseId } }
          deletedBy { __typename login ... on User { databaseId } ... on Bot { databaseId } }
        }
      }
    }
  }
}`;

export function contentSha256(body) {
  if (typeof body !== 'string') throw new ProtocolError('authoritative GitHub content body must be a string');
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function actorIdentity(actor) {
  if (!actor || typeof actor !== 'object') return null;
  const databaseId = actor.databaseId;
  if (databaseId == null || !/^\d+$/u.test(String(databaseId))) return null;
  return {
    actorId: String(databaseId),
    actorType: typeof actor.__typename === 'string' ? actor.__typename : null,
    actorLogin: typeof actor.login === 'string' ? actor.login : null,
  };
}

function rejection(candidate, reason, extra = {}) {
  return {
    verified: false,
    reason,
    nodeId: candidate.nodeId ?? null,
    expectedType: candidate.expectedType ?? null,
    contentSha256: typeof candidate.body === 'string' ? contentSha256(candidate.body) : null,
    creatorActorId: candidate.authorId == null ? null : String(candidate.authorId),
    creatorLogin: candidate.authorLogin ?? null,
    currentEditorActorId: null,
    editorActorIds: [],
    editCount: null,
    redactedEditCount: null,
    historyComplete: false,
    lastEditedAt: null,
    ...extra,
  };
}

function verifyNode(candidate, node, trustedActorIds) {
  const bodyDigest = contentSha256(candidate.body);
  if (!node || typeof node !== 'object') return rejection(candidate, 'provenance-node-not-found');
  if (node.__typename !== candidate.expectedType) {
    return rejection(candidate, 'provenance-type-mismatch', { observedType: node.__typename ?? null });
  }
  if (node.id !== candidate.nodeId) return rejection(candidate, 'provenance-node-id-mismatch');
  if (typeof node.body !== 'string' || node.body !== candidate.body) {
    return rejection(candidate, 'provenance-content-race', { observedContentSha256: typeof node.body === 'string' ? contentSha256(node.body) : null });
  }

  const author = actorIdentity(node.author);
  if (!author) return rejection(candidate, 'provenance-creator-missing');
  if (author.actorId !== String(candidate.authorId ?? '')) {
    return rejection(candidate, 'provenance-creator-mismatch', { creatorActorId: author.actorId, creatorLogin: author.actorLogin });
  }
  if (!trustedActorIds.has(author.actorId)) {
    return rejection(candidate, 'untrusted-creator', { creatorActorId: author.actorId, creatorLogin: author.actorLogin });
  }

  const edits = node.userContentEdits;
  if (!edits || typeof edits !== 'object') {
    return rejection(candidate, 'provenance-history-missing', { creatorActorId: author.actorId, creatorLogin: author.actorLogin });
  }
  const totalCount = Number(edits.totalCount);
  const editNodes = Array.isArray(edits.nodes) ? edits.nodes : null;
  const pageInfo = edits.pageInfo;
  if (!Number.isSafeInteger(totalCount) || totalCount < 0 || !editNodes || !pageInfo || typeof pageInfo !== 'object') {
    return rejection(candidate, 'provenance-history-malformed', { creatorActorId: author.actorId, creatorLogin: author.actorLogin });
  }
  if (pageInfo.hasNextPage === true || pageInfo.hasPreviousPage === true || editNodes.length !== totalCount) {
    return rejection(candidate, 'provenance-history-truncated', {
      creatorActorId: author.actorId,
      creatorLogin: author.actorLogin,
      editCount: totalCount,
    });
  }
  // GitHub retains at most 100 revisions. At the retention ceiling older
  // intermediate edits may already have been discarded, so exact provenance is
  // no longer knowable and machine authority must fail closed.
  if (totalCount >= MAX_RETAINED_CONTENT_EDITS) {
    return rejection(candidate, 'provenance-history-saturated', {
      creatorActorId: author.actorId,
      creatorLogin: author.actorLogin,
      editCount: totalCount,
    });
  }

  const lastEditedAt = node.lastEditedAt ?? null;
  if (lastEditedAt == null) {
    if (node.editor != null || totalCount !== 0 || node.includesCreatedEdit === true) {
      return rejection(candidate, 'provenance-history-inconsistent', {
        creatorActorId: author.actorId,
        creatorLogin: author.actorLogin,
        editCount: totalCount,
      });
    }
    return {
      verified: true,
      reason: null,
      nodeId: candidate.nodeId,
      expectedType: candidate.expectedType,
      contentSha256: bodyDigest,
      creatorActorId: author.actorId,
      creatorLogin: author.actorLogin,
      currentEditorActorId: null,
      editorActorIds: [],
      editCount: 0,
      redactedEditCount: 0,
      historyComplete: true,
      lastEditedAt: null,
    };
  }

  const currentEditor = actorIdentity(node.editor);
  if (!currentEditor) {
    return rejection(candidate, 'provenance-current-editor-missing', {
      creatorActorId: author.actorId,
      creatorLogin: author.actorLogin,
      editCount: totalCount,
      lastEditedAt,
    });
  }
  if (!trustedActorIds.has(currentEditor.actorId)) {
    return rejection(candidate, 'untrusted-current-editor', {
      creatorActorId: author.actorId,
      creatorLogin: author.actorLogin,
      currentEditorActorId: currentEditor.actorId,
      editCount: totalCount,
      lastEditedAt,
    });
  }
  if (node.includesCreatedEdit !== true || totalCount === 0) {
    return rejection(candidate, 'provenance-creation-history-missing', {
      creatorActorId: author.actorId,
      creatorLogin: author.actorLogin,
      currentEditorActorId: currentEditor.actorId,
      editCount: totalCount,
      lastEditedAt,
    });
  }

  const editorIds = [];
  let redactedEditCount = 0;
  let currentRevisionMatched = false;
  for (const edit of editNodes) {
    if (!edit || typeof edit !== 'object' || typeof edit.id !== 'string' || typeof edit.editedAt !== 'string') {
      return rejection(candidate, 'provenance-edit-metadata-missing', {
        creatorActorId: author.actorId,
        creatorLogin: author.actorLogin,
        currentEditorActorId: currentEditor.actorId,
        editorActorIds: [...new Set(editorIds)],
        editCount: totalCount,
        redactedEditCount,
        lastEditedAt,
      });
    }
    const editor = actorIdentity(edit.editor);
    if (!editor) {
      return rejection(candidate, 'provenance-edit-actor-missing', {
        creatorActorId: author.actorId,
        creatorLogin: author.actorLogin,
        currentEditorActorId: currentEditor.actorId,
        editorActorIds: [...new Set(editorIds)],
        editCount: totalCount,
        redactedEditCount,
        lastEditedAt,
      });
    }
    editorIds.push(editor.actorId);
    if (!trustedActorIds.has(editor.actorId)) {
      return rejection(candidate, 'untrusted-editor', {
        creatorActorId: author.actorId,
        creatorLogin: author.actorLogin,
        currentEditorActorId: currentEditor.actorId,
        editorActorIds: [...new Set(editorIds)],
        editCount: totalCount,
        redactedEditCount,
        lastEditedAt,
      });
    }
    if (edit.deletedAt != null) redactedEditCount += 1;
    if (edit.editedAt === lastEditedAt && editor.actorId === currentEditor.actorId) currentRevisionMatched = true;
  }
  if (!currentRevisionMatched) {
    return rejection(candidate, 'provenance-current-revision-mismatch', {
      creatorActorId: author.actorId,
      creatorLogin: author.actorLogin,
      currentEditorActorId: currentEditor.actorId,
      editorActorIds: [...new Set(editorIds)],
      editCount: totalCount,
      redactedEditCount,
      lastEditedAt,
    });
  }

  return {
    verified: true,
    reason: null,
    nodeId: candidate.nodeId,
    expectedType: candidate.expectedType,
    contentSha256: bodyDigest,
    creatorActorId: author.actorId,
    creatorLogin: author.actorLogin,
    currentEditorActorId: currentEditor.actorId,
    editorActorIds: [...new Set(editorIds)],
    editCount: totalCount,
    redactedEditCount,
    historyComplete: true,
    lastEditedAt,
  };
}

export class GitHubContentProvenance {
  #client;
  #trustedActorIds;

  constructor({ client, trustedActorIds }) {
    if (!client || typeof client.graphql !== 'function') throw new TypeError('content provenance requires a GraphQL-capable GitHub client');
    this.#client = client;
    this.#trustedActorIds = new Set((trustedActorIds ?? []).map(String));
  }

  async verify(candidate) {
    const [result] = await this.verifyMany([candidate]);
    return result;
  }

  async verifyMany(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > MAX_BATCH) {
      throw new TypeError(`content provenance candidates must contain 1-${MAX_BATCH} items`);
    }
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || typeof candidate.nodeId !== 'string' || candidate.nodeId.length === 0) {
        throw new TypeError('content provenance candidate nodeId is required');
      }
      if (!['Issue', 'IssueComment'].includes(candidate.expectedType)) throw new TypeError('content provenance candidate type is invalid');
      if (typeof candidate.body !== 'string') throw new TypeError('content provenance candidate body must be a string');
      if (!/^\d+$/u.test(String(candidate.authorId ?? ''))) throw new TypeError('content provenance candidate authorId must be numeric');
    }

    const response = await this.#client.graphql(CONTENT_PROVENANCE_QUERY, { ids: candidates.map((entry) => entry.nodeId) });
    if (!Array.isArray(response.data?.nodes) || response.data.nodes.length !== candidates.length) {
      throw new ProtocolError('GitHub content provenance response did not preserve candidate cardinality');
    }
    return candidates.map((candidate, index) => verifyNode(candidate, response.data.nodes[index], this.#trustedActorIds));
  }
}
