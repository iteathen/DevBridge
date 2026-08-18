import { GitHubContentProvenance, contentSha256 } from './content-provenance.js';
import { parseFeedbackEnvelope } from './feedback-envelope.js';

const PROVENANCE_BATCH = 30;

function boundedDetail(error) {
  const text = String(error?.message ?? error ?? 'GitHub content provenance unavailable').replace(/[\r\n\t]+/gu, ' ').trim();
  return text.length <= 400 ? text : `${text.slice(0, 397)}...`;
}

function unverifiedProvenance(comment, reason) {
  const body = typeof comment?.body === 'string' ? comment.body : '';
  return {
    verified: false,
    reason,
    nodeId: comment?.node_id ?? null,
    expectedType: 'IssueComment',
    contentSha256: contentSha256(body),
    creatorActorId: String(comment?.user?.id ?? ''),
    creatorLogin: comment?.user?.login ?? null,
    currentEditorActorId: null,
    editorActorIds: [],
    editCount: null,
    redactedEditCount: null,
    historyComplete: false,
    lastEditedAt: null,
  };
}

export class IssueFeedbackSource {
  #client;
  #queueRepository;
  #trustedActorIds;
  #contentProvenance;

  constructor({ client, queueRepository, trustedActorIds, contentProvenance = null }) {
    this.#client = client;
    this.#queueRepository = queueRepository;
    this.#trustedActorIds = new Set(trustedActorIds.map(String));
    this.#contentProvenance = contentProvenance ?? new GitHubContentProvenance({ client, trustedActorIds });
  }

  async #invalidate(requestPath) {
    if (typeof this.#client.invalidateConditional === 'function') {
      await this.#client.invalidateConditional(requestPath).catch(() => {});
    }
  }

  async pollWaitingRun({ issueNumber, runId, taskRevision, afterCommentId = 0 }) {
    const [owner, repo] = this.#queueRepository.split('/');
    const requestPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`;
    const response = await this.#client.request('GET', requestPath, { conditional: true });
    if (response.notModified) return { feedback: null, rejected: [], unchanged: true, highestCommentId: afterCommentId };
    if (!Array.isArray(response.data)) throw new TypeError('GitHub issue comments response must be an array');

    let highestCommentId = afterCommentId;
    const rejected = [];
    const pending = [];

    for (const comment of response.data) {
      const commentId = Number(comment?.id ?? 0);
      if (commentId <= afterCommentId) continue;
      highestCommentId = Math.max(highestCommentId, commentId);

      let feedback;
      try {
        feedback = parseFeedbackEnvelope(comment.body ?? '');
      } catch {
        // Unstructured comments are ordinary discussion, not machine authority.
        continue;
      }
      if (feedback.runId !== runId || feedback.taskRevision !== taskRevision) continue;

      const actorId = String(comment?.user?.id ?? '');
      if (!this.#trustedActorIds.has(actorId)) {
        rejected.push({
          commentId,
          reason: 'untrusted-creator',
          actorId,
          provenance: unverifiedProvenance(comment, 'untrusted-creator'),
        });
        continue;
      }
      if (typeof comment?.node_id !== 'string' || comment.node_id.length === 0) {
        rejected.push({
          commentId,
          reason: 'provenance-node-id-missing',
          actorId,
          provenance: unverifiedProvenance(comment, 'provenance-node-id-missing'),
        });
        continue;
      }

      pending.push({
        comment,
        commentId,
        actorId,
        feedback,
        candidate: {
          nodeId: comment.node_id,
          expectedType: 'IssueComment',
          body: comment.body ?? '',
          authorId: actorId,
          authorLogin: comment.user?.login ?? null,
        },
      });
    }

    const provenanceResults = [];
    try {
      for (let offset = 0; offset < pending.length; offset += PROVENANCE_BATCH) {
        const slice = pending.slice(offset, offset + PROVENANCE_BATCH);
        provenanceResults.push(...await this.#contentProvenance.verifyMany(slice.map((entry) => entry.candidate)));
      }
    } catch (error) {
      // Do not advance the comment cursor on a provenance infrastructure
      // failure. Clear the REST validator so the exact comments are fetched and
      // reverified on the next bounded poll.
      await this.#invalidate(requestPath);
      const detail = boundedDetail(error);
      return {
        feedback: null,
        rejected: pending.map((entry) => ({
          commentId: entry.commentId,
          reason: 'provenance-unavailable',
          detail,
          actorId: entry.actorId,
          provenance: unverifiedProvenance(entry.comment, 'provenance-unavailable'),
        })),
        unchanged: false,
        highestCommentId: afterCommentId,
        provenanceRetryRequired: true,
      };
    }

    for (let index = 0; index < pending.length; index += 1) {
      const entry = pending[index];
      const provenance = provenanceResults[index];
      if (!provenance?.verified) {
        if (provenance?.reason === 'provenance-content-race') await this.#invalidate(requestPath);
        rejected.push({
          commentId: entry.commentId,
          reason: provenance?.reason ?? 'provenance-unavailable',
          actorId: entry.actorId,
          provenance: provenance ?? unverifiedProvenance(entry.comment, 'provenance-unavailable'),
        });
        continue;
      }
      if (provenance.contentSha256 !== entry.feedback.contentSha256) {
        await this.#invalidate(requestPath);
        rejected.push({
          commentId: entry.commentId,
          reason: 'provenance-digest-mismatch',
          actorId: entry.actorId,
          provenance: { ...provenance, verified: false, reason: 'provenance-digest-mismatch' },
        });
        continue;
      }

      return {
        feedback: {
          ...entry.feedback,
          commentId: entry.commentId,
          actorId: entry.actorId,
          actorLogin: entry.comment.user?.login ?? null,
          createdAt: entry.comment.created_at ?? null,
          provenance,
        },
        rejected,
        unchanged: false,
        highestCommentId: entry.commentId,
      };
    }

    return { feedback: null, rejected, unchanged: false, highestCommentId };
  }
}
