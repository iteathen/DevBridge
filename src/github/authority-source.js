import { createHash } from 'node:crypto';

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function isUneditedAuthorityComment(comment) {
  const createdAt = comment?.created_at;
  const updatedAt = comment?.updated_at;
  return typeof createdAt === 'string' && createdAt !== '' && createdAt === updatedAt;
}

export function isExactAuthorityFence(body, kind) {
  if (typeof body !== 'string' || !/^[a-z0-9-]+$/u.test(kind)) return false;
  const normalized = body.trim();
  return normalized.startsWith(`\`\`\`patch-poller-${kind}\n`) && normalized.endsWith('\n```') &&
    !normalized.startsWith('>') && !normalized.includes('\n> ```patch-poller-');
}

export function authorityBodyDigest(body) {
  return sha256(typeof body === 'string' ? body : '');
}

export function authoritySource(comment, { issueId = null, issueNumber = null } = {}) {
  if (!isUneditedAuthorityComment(comment)) throw new TypeError('authority source comment must be unedited');
  return {
    kind: 'github-issue-comment',
    issueId: issueId == null ? null : String(issueId),
    issueNumber: issueNumber == null ? null : Number(issueNumber),
    commentId: String(comment.id),
    actorId: String(comment.user?.id ?? ''),
    actorLogin: comment.user?.login ?? null,
    createdAt: comment.created_at,
    bodySha256: authorityBodyDigest(comment.body ?? ''),
    edited: false,
  };
}

export function sourceBoundRevision(envelopeRevision, source) {
  const canonical = JSON.stringify({
    protocol: 'patch-poller/authority-binding-v1',
    envelopeRevision: String(envelopeRevision),
    source: {
      kind: source.kind,
      issueId: source.issueId,
      issueNumber: source.issueNumber,
      commentId: source.commentId,
      actorId: source.actorId,
      createdAt: source.createdAt,
      bodySha256: source.bodySha256,
    },
  });
  return sha256(canonical);
}
