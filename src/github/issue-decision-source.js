import { authoritySource, isExactAuthorityFence, isUneditedAuthorityComment } from './authority-source.js';
import { parseDecisionEnvelope } from './decision-envelope.js';

export class IssueDecisionSource {
  #client;
  #queueRepository;
  #authorities;

  constructor({ client, queueRepository, authorities = {} }) {
    this.#client = client;
    this.#queueRepository = queueRepository;
    this.#authorities = Object.fromEntries(
      Object.entries(authorities).map(([decisionClass, actorIds]) => [decisionClass, new Set((actorIds ?? []).map(String))])
    );
  }

  authorizedActorIds(decisionClass) {
    return [...(this.#authorities[decisionClass] ?? new Set())];
  }

  async pollCheckpoint({ issueNumber, checkpoint, afterCommentId = 0, now = Date.now() }) {
    const allowed = this.#authorities[checkpoint.decisionClass] ?? new Set();
    if (allowed.size === 0) {
      return { decision: null, unchanged: true, highestCommentId: afterCommentId, reason: 'no-local-authority' };
    }
    if (checkpoint.expiresAt && now >= Date.parse(checkpoint.expiresAt)) {
      return { decision: null, unchanged: true, highestCommentId: afterCommentId, reason: 'expired' };
    }

    const [owner, repo] = this.#queueRepository.split('/');
    const response = await this.#client.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`,
      { conditional: true }
    );
    if (response.notModified) return { decision: null, unchanged: true, highestCommentId: afterCommentId, reason: 'no-change' };
    if (!Array.isArray(response.data)) throw new TypeError('GitHub issue comments response must be an array');

    const createdAtMs = Date.parse(checkpoint.createdAt ?? '');
    let highestCommentId = afterCommentId;
    for (const comment of response.data) {
      const commentId = Number(comment?.id ?? 0);
      if (commentId <= afterCommentId) continue;
      highestCommentId = Math.max(highestCommentId, commentId);
      if (!allowed.has(String(comment?.user?.id ?? ''))) continue;
      if (!isUneditedAuthorityComment(comment) || !isExactAuthorityFence(comment.body, 'decision')) continue;
      const commentCreatedAtMs = Date.parse(comment.created_at ?? '');
      if (!Number.isFinite(commentCreatedAtMs) || (Number.isFinite(createdAtMs) && commentCreatedAtMs < createdAtMs)) continue;

      try {
        const decision = parseDecisionEnvelope(comment.body);
        if (decision.runId !== checkpoint.runId) continue;
        if (decision.taskRevision !== checkpoint.taskRevision) continue;
        if (decision.checkpointId !== checkpoint.checkpointId) continue;
        if (decision.subjectDigest !== checkpoint.subjectDigest) continue;
        const source = authoritySource(comment, { issueNumber });
        return {
          decision: {
            ...decision,
            actorId: source.actorId,
            actorLogin: source.actorLogin,
            commentId,
            createdAt: source.createdAt,
            authority: source,
          },
          unchanged: false,
          highestCommentId,
          reason: null,
        };
      } catch {
        // Ordinary comments, quoted examples, and malformed decisions are not authority.
      }
    }

    return { decision: null, unchanged: false, highestCommentId, reason: 'no-matching-decision' };
  }
}
