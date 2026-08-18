import { createHash } from 'node:crypto';
import { parseFeedbackEnvelope } from './feedback-envelope.js';
import { parseDecisionEnvelope } from './decision-envelope.js';

function contentSha256(body) {
  return createHash('sha256').update(String(body ?? ''), 'utf8').digest('hex');
}

function isUnedited(comment) {
  return typeof comment?.created_at === 'string' && comment.created_at !== '' && comment.updated_at === comment.created_at;
}

export class IssueFeedbackSource {
  #client;
  #queueRepository;
  #trustedActorIds;

  constructor({ client, queueRepository, trustedActorIds }) {
    this.#client = client;
    this.#queueRepository = queueRepository;
    this.#trustedActorIds = new Set(trustedActorIds.map(String));
  }

  async #comments(issueNumber) {
    const [owner, repo] = this.#queueRepository.split('/');
    const response = await this.#client.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`,
      { conditional: true }
    );
    if (response.notModified) return { comments: [], unchanged: true };
    if (!Array.isArray(response.data)) throw new TypeError('GitHub issue comments response must be an array');
    return { comments: response.data, unchanged: false };
  }

  async pollWaitingRun({ issueNumber, runId, taskRevision, afterCommentId = 0 }) {
    const observed = await this.#comments(issueNumber);
    if (observed.unchanged) return { feedback: null, unchanged: true, highestCommentId: afterCommentId };

    let highestCommentId = afterCommentId;
    for (const comment of observed.comments) {
      const commentId = Number(comment?.id ?? 0);
      if (commentId <= afterCommentId) continue;
      highestCommentId = Math.max(highestCommentId, commentId);
      const actorId = String(comment?.user?.id ?? '');
      if (!this.#trustedActorIds.has(actorId) || !isUnedited(comment)) continue;

      try {
        const feedback = parseFeedbackEnvelope(comment.body ?? '');
        if (feedback.runId !== runId || feedback.taskRevision !== taskRevision) continue;
        return {
          feedback: {
            ...feedback,
            commentId,
            actorId,
            actorLogin: comment.user?.login ?? null,
            createdAt: comment.created_at,
            contentSha256: contentSha256(comment.body),
            unedited: true,
          },
          unchanged: false,
          highestCommentId
        };
      } catch {
        // Unstructured, edited, quoted, or mismatched comments are ordinary discussion.
      }
    }
    return { feedback: null, unchanged: false, highestCommentId };
  }

  async pollDecision({
    issueNumber,
    runId,
    taskRevision,
    checkpointId,
    subjectDigest,
    authorizedActorIds = [],
    afterCommentId = 0,
  }) {
    const observed = await this.#comments(issueNumber);
    if (observed.unchanged) return { decision: null, unchanged: true, highestCommentId: afterCommentId };
    const authority = new Set(authorizedActorIds.map(String));
    let highestCommentId = afterCommentId;

    for (const comment of observed.comments) {
      const commentId = Number(comment?.id ?? 0);
      if (commentId <= afterCommentId) continue;
      highestCommentId = Math.max(highestCommentId, commentId);
      const actorId = String(comment?.user?.id ?? '');
      if (!this.#trustedActorIds.has(actorId) || !authority.has(actorId) || !isUnedited(comment)) continue;
      try {
        const decision = parseDecisionEnvelope(comment.body ?? '');
        if (decision.runId !== runId || decision.taskRevision !== taskRevision || decision.checkpointId !== checkpointId || decision.subjectDigest !== subjectDigest) continue;
        return {
          decision: {
            ...decision,
            commentId,
            actorId,
            actorLogin: comment.user?.login ?? null,
            createdAt: comment.created_at,
            contentSha256: contentSha256(comment.body),
            unedited: true,
          },
          unchanged: false,
          highestCommentId,
        };
      } catch {
        // Invalid decision-shaped comments carry no authority.
      }
    }
    return { decision: null, unchanged: false, highestCommentId };
  }
}
