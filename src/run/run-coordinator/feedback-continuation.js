const PROVENANCE_LIMIT = 100;

function createRecord(entry, { accepted, action, kind, projectEvidence, now }) {
  return {
    source: kind,
    accepted,
    action,
    commentId: entry.commentId ?? null,
    actorId: entry.actorId ?? null,
    reason: accepted ? null : (entry.reason ?? entry.provenance?.reason ?? 'provenance-rejected'),
    content: projectEvidence(entry.provenance),
    recordedAt: now(),
  };
}

export class FeedbackContinuation {
  #kinds;
  #projectEvidence;
  #now;

  constructor({ recordKinds, projectEvidence, now }) {
    this.#kinds = { ...recordKinds };
    this.#projectEvidence = projectEvidence;
    this.#now = now;
  }

  interpret({ poll, provenance, cursor, completed, limit, extension }) {
    const rejected = Array.isArray(poll.rejected) ? poll.rejected : [];
    const records = [
      ...(Array.isArray(provenance) ? provenance : []),
      ...rejected.map((entry) => createRecord(entry, {
        accepted: false,
        action: null,
        kind: this.#kinds.rejected,
        projectEvidence: this.#projectEvidence,
        now: this.#now,
      })),
    ].slice(-PROVENANCE_LIMIT);
    const nextCursor = poll.highestCommentId ?? cursor ?? 0;

    if (!poll.feedback) {
      return {
        kind: 'idle',
        provenance: records,
        cursor: nextCursor,
        rejectedCount: rejected.length,
        retryRequired: poll.provenanceRetryRequired === true,
      };
    }

    const feedback = poll.feedback;
    records.push(createRecord(feedback, {
      accepted: true,
      action: feedback.action,
      kind: this.#kinds.accepted,
      projectEvidence: this.#projectEvidence,
      now: this.#now,
    }));
    const boundedRecords = records.slice(-PROVENANCE_LIMIT);
    const commonDecision = {
      source: this.#kinds.decision,
      action: feedback.action,
      actorId: feedback.actorId,
      commentId: feedback.commentId,
      contentSha256: feedback.contentSha256,
      contentProvenance: this.#projectEvidence(feedback.provenance),
    };

    if (feedback.action === 'cancel') {
      return {
        kind: 'cancel',
        provenance: boundedRecords,
        cursor: nextCursor,
        decision: { ...commonDecision, note: feedback.instructions ?? null },
      };
    }

    return {
      kind: 'continue',
      provenance: boundedRecords,
      cursor: nextCursor,
      decision: { ...commonDecision, instructions: feedback.instructions },
      limit: completed >= limit ? completed + extension : limit,
    };
  }
}
