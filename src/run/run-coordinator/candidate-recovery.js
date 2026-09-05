const HISTORY_LIMIT = 20;

export class CandidateRecovery {
  #now;

  constructor({ now }) {
    this.#now = now;
  }

  rejection({ summary, nextStep }) {
    return {
      summary,
      blockers: [summary],
      nextStep,
    };
  }

  baselineReverification({ reconciliation, snapshot, history, summary, nextStep }) {
    const entry = {
      fromBaseSha: reconciliation.fromBaseSha ?? null,
      toBaseSha: reconciliation.toBaseSha ?? snapshot.publicationBaseSha,
      fromHeadSha: reconciliation.fromHeadSha ?? null,
      toHeadSha: reconciliation.toHeadSha ?? snapshot.headSha,
      recordedAt: this.#now(),
    };
    return {
      summary,
      history: [...(Array.isArray(history) ? history : []), entry].slice(-HISTORY_LIMIT),
      nextStep,
    };
  }

  boundedReverification({ completed, limit, exhausted }) {
    const current = Math.max(1, completed);
    if (current < limit) return { exhausted: false, next: current + 1 };
    return { exhausted: true, ...exhausted };
  }

  baselineCheckpoint({ summary, nextStep }) {
    return {
      summary,
      blockers: [summary],
      nextStep,
    };
  }

  localReverification({ observed, verified, completed, limit, exhausted }) {
    const reasons = [];
    if (observed.dirty) reasons.push('the managed worktree became dirty');
    if (observed.headSha !== verified.headSha) reasons.push(`HEAD moved from verified ${verified.headSha} to ${observed.headSha}`);
    const observedBase = observed.publicationBaseSha ?? observed.baseSha;
    const verifiedBase = verified.publicationBaseSha ?? verified.baseSha;
    if (observedBase !== verifiedBase) {
      reasons.push(`publication baseline changed from ${verifiedBase} to ${observedBase}`);
    }
    return {
      reasons,
      attempt: this.boundedReverification({ completed, limit, exhausted }),
    };
  }
}
