import { parseFeedbackEnvelope } from './feedback-envelope.js';

export class IssueFeedbackSource {
  #client;
  #queueRepository;
  #trustedActorIds;

  constructor({ client, queueRepository, trustedActorIds }) {
    this.#client = client;
    this.#queueRepository = queueRepository;
    this.#trustedActorIds = new Set(trustedActorIds.map(String));
  }

  async pollWaitingRun({ issueNumber, runId, taskRevision, afterCommentId = 0 }) {
    const [owner, repo] = this.#queueRepository.split('/');
    const response = await this.#client.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`,
      { conditional: true }
    );
    if (response.notModified) return { feedback: null, unchanged: true, highestCommentId: afterCommentId };
    if (!Array.isArray(response.data)) throw new TypeError('GitHub issue comments response must be an array');

    let highestCommentId = afterCommentId;
    for (const comment of response.data) {
      const commentId = Number(comment?.id ?? 0);
      if (commentId <= afterCommentId) continue;
      highestCommentId = Math.max(highestCommentId, commentId);
      if (!this.#trustedActorIds.has(String(comment?.user?.id ?? ''))) continue;

      try {
        const feedback = parseFeedbackEnvelope(comment.body ?? '');
        if (feedback.runId !== runId || feedback.taskRevision !== taskRevision) continue;
        return {
          feedback: {
            ...feedback,
            commentId,
            actorId: String(comment.user.id),
            actorLogin: comment.user?.login ?? null,
            createdAt: comment.created_at ?? null
          },
          unchanged: false,
          highestCommentId
        };
      } catch {
        // Unstructured comments are ordinary discussion, not machine authority.
      }
    }

    return { feedback: null, unchanged: false, highestCommentId };
  }
}
