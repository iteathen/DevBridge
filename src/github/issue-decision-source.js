import { GitHubContentProvenance, contentSha256 } from './content-provenance.js';
import { parseDecisionEnvelope } from './decision-envelope.js';

const PROVENANCE_BATCH = 30;

function boundedDetail(error) {
  const text = String(error?.message ?? error ?? 'GitHub decision provenance unavailable').replace(/[\r\n\t]+/gu, ' ').trim();
  return text.length <= 400 ? text : `${text.slice(0, 397)}...`;
}

function rejectedDecision(comment, reason, extra = {}) {
  return {
    commentId: Number(comment?.id ?? 0),
    actorId: String(comment?.user?.id ?? ''),
    reason,
    contentSha256: contentSha256(typeof comment?.body === 'string' ? comment.body : ''),
    ...extra,
  };
}

export class IssueDecisionSource {
  #client;
  #queueRepository;

  constructor({ client, queueRepository }) {
    this.#client = client;
    this.#queueRepository = queueRepository;
  }

  async #invalidate(requestPath) {
    if (typeof this.#client.invalidateConditional === 'function') {
      await this.#client.invalidateConditional(requestPath).catch(() => {});
    }
  }

  async pollWaitingDecision({
    issueNumber,
    runId,
    taskRevision,
    checkpointId,
    subjectDigest,
    authorizedActorIds,
    afterCommentId = 0,
  }) {
    const authorized = new Set((authorizedActorIds ?? []).map(String));
    const [owner, repo] = this.#queueRepository.split('/');
    const requestPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`;
    const response = await this.#client.request('GET', requestPath, { conditional: true });
    if (response.notModified) {
      return { decision: null, rejected: [], unchanged: true, highestCommentId: afterCommentId };
    }
    if (!Array.isArray(response.data)) throw new TypeError('GitHub issue comments response must be an array');

    let highestCommentId = afterCommentId;
    const rejected = [];
    const pending = [];

    for (const comment of response.data) {
      const commentId = Number(comment?.id ?? 0);
      if (commentId <= afterCommentId) continue;
      highestCommentId = Math.max(highestCommentId, commentId);

      let decision;
      try {
        decision = parseDecisionEnvelope(comment.body ?? '');
      } catch {
        continue;
      }
      if (decision.runId !== runId || decision.taskRevision !== taskRevision) continue;
      if (decision.checkpointId !== checkpointId) {
        rejected.push(rejectedDecision(comment, 'decision-checkpoint-mismatch'));
        continue;
      }
      if (decision.subjectDigest !== subjectDigest) {
        rejected.push(rejectedDecision(comment, 'decision-subject-mismatch'));
        continue;
      }

      const actorId = String(comment?.user?.id ?? '');
      if (!authorized.has(actorId)) {
        rejected.push(rejectedDecision(comment, 'decision-actor-unauthorized'));
        continue;
      }
      if (typeof comment?.node_id !== 'string' || comment.node_id.length === 0) {
        rejected.push(rejectedDecision(comment, 'decision-provenance-node-id-missing'));
        continue;
      }

      pending.push({
        comment,
        commentId,
        actorId,
        decision,
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
      const verifier = new GitHubContentProvenance({ client: this.#client, trustedActorIds: [...authorized] });
      for (let offset = 0; offset < pending.length; offset += PROVENANCE_BATCH) {
        const slice = pending.slice(offset, offset + PROVENANCE_BATCH);
        provenanceResults.push(...await verifier.verifyMany(slice.map((entry) => entry.candidate)));
      }
    } catch (error) {
      await this.#invalidate(requestPath);
      const detail = boundedDetail(error);
      return {
        decision: null,
        rejected: pending.map((entry) => rejectedDecision(entry.comment, 'decision-provenance-unavailable', { detail })),
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
        rejected.push(rejectedDecision(entry.comment, provenance?.reason ?? 'decision-provenance-unavailable', { provenance }));
        continue;
      }
      if (provenance.contentSha256 !== entry.decision.contentSha256) {
        await this.#invalidate(requestPath);
        rejected.push(rejectedDecision(entry.comment, 'decision-provenance-digest-mismatch', {
          provenance: { ...provenance, verified: false, reason: 'decision-provenance-digest-mismatch' },
        }));
        continue;
      }

      return {
        decision: {
          ...entry.decision,
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

    return { decision: null, rejected, unchanged: false, highestCommentId };
  }
}
