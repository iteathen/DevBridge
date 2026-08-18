import { verifyContentProvenance } from './content-provenance.js';
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
    const response = await this.#client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`, { conditional: true });
    if (response.notModified) return { feedback: null, rejected: [], unchanged: true, highestCommentId: afterCommentId };
    if (!Array.isArray(response.data)) throw new TypeError('GitHub issue comments response must be an array');

    let highestCommentId = afterCommentId;
    const rejected = [];
    for (const comment of response.data) {
      const commentId = Number(comment?.id ?? 0);
      if (commentId <= afterCommentId) continue;
      highestCommentId = Math.max(highestCommentId, commentId);
      const actorId = String(comment?.user?.id ?? '');
      if (!this.#trustedActorIds.has(actorId)) continue;

      let feedback;
      try { feedback = parseFeedbackEnvelope(comment.body ?? ''); }
      catch { continue; }
      if (feedback.runId !== runId || feedback.taskRevision !== taskRevision) continue;
      try {
        const provenance = await verifyContentProvenance({
          client: this.#client,
          nodeId: comment.node_id,
          expectedBody: comment.body ?? '',
          creatorId: actorId,
          trustedActorIds: this.#trustedActorIds,
          expectedType: 'IssueComment',
        });
        return {
          feedback: {
            ...feedback,
            commentId,
            commentNodeId: comment.node_id,
            actorId,
            actorLogin: comment.user?.login ?? null,
            createdAt: comment.created_at ?? null,
            authorityProvenance: provenance,
          },
          rejected,
          unchanged: false,
          highestCommentId,
        };
      } catch (error) {
        rejected.push({ commentId, reason: 'unverifiable-content-provenance', detail: error.message });
      }
    }
    return { feedback: null, rejected, unchanged: false, highestCommentId };
  }
}
