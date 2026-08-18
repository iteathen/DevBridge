import {
  classifySensitiveCandidate,
  createHardGateCheckpoint,
  decisionAuthorityActors,
  decisionMatchesCheckpoint,
} from './hard-gate-policy.js';
import { candidateArtifactSubject } from './candidate-subject.js';

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function provenanceProjection(provenance) {
  if (!provenance || typeof provenance !== 'object') return null;
  return {
    verified: provenance.verified === true,
    reason: provenance.reason ?? null,
    contentSha256: provenance.contentSha256 ?? null,
    creatorActorId: provenance.creatorActorId ?? null,
    currentEditorActorId: provenance.currentEditorActorId ?? null,
    editorActorIds: Array.isArray(provenance.editorActorIds) ? provenance.editorActorIds.slice(0, 20) : [],
    editCount: Number.isInteger(provenance.editCount) ? provenance.editCount : null,
    redactedEditCount: Number.isInteger(provenance.redactedEditCount) ? provenance.redactedEditCount : null,
    historyComplete: provenance.historyComplete === true,
    lastEditedAt: provenance.lastEditedAt ?? null,
  };
}

function rejectedDecisionRecord(entry, at) {
  return {
    source: 'github-decision-rejected',
    accepted: false,
    commentId: entry.commentId ?? null,
    actorId: entry.actorId ?? null,
    reason: entry.reason ?? entry.provenance?.reason ?? 'decision-rejected-by-policy',
    contentSha256: entry.contentSha256 ?? entry.provenance?.contentSha256 ?? null,
    content: provenanceProjection(entry.provenance),
    recordedAt: at,
  };
}

function acceptedDecisionRecord(decision, checkpoint, at) {
  return {
    source: 'github-decision',
    accepted: true,
    action: decision.action,
    commentId: decision.commentId,
    actorId: decision.actorId,
    checkpointId: checkpoint.checkpointId,
    subjectDigest: checkpoint.subjectDigest,
    decisionClasses: [...checkpoint.decisionClasses],
    contentSha256: decision.contentSha256,
    content: provenanceProjection(decision.provenance),
    recordedAt: at,
  };
}

function checkpointRecord(checkpoint, state, at) {
  return {
    source: 'hard-gate-checkpoint',
    checkpointId: checkpoint.checkpointId,
    type: checkpoint.type,
    bindingMode: checkpoint.bindingMode,
    state,
    subjectDigest: checkpoint.subjectDigest,
    decisionClasses: [...checkpoint.decisionClasses],
    changedFiles: [...checkpoint.changedFiles],
    expiresAt: checkpoint.expiresAt,
    recordedAt: at,
  };
}

export class HardGateController {
  #source;
  #authorities;
  #approvalTtlMs;
  #architectureFileThreshold;
  #architectureOwnerThreshold;
  #nowMs;

  constructor({
    decisionSource = null,
    decisionAuthorities = {},
    approvalTtlMs = 86_400_000,
    architectureFileThreshold = 20,
    architectureOwnerThreshold = 4,
    nowMs = () => Date.now(),
  } = {}) {
    this.#source = decisionSource;
    this.#authorities = structuredClone(decisionAuthorities ?? {});
    this.#approvalTtlMs = approvalTtlMs;
    this.#architectureFileThreshold = architectureFileThreshold;
    this.#architectureOwnerThreshold = architectureOwnerThreshold;
    this.#nowMs = nowMs;
  }

  #state(state) {
    state.decisionGates ??= {
      checkpoints: [],
      currentCheckpointId: null,
      lastDecisionCommentId: 0,
    };
    state.decisionGates.checkpoints ??= [];
    state.decisionGates.lastDecisionCommentId ??= 0;
    state.prior.provenance ??= [];
    state.prior.decisions ??= [];
    return state.decisionGates;
  }

  currentCheckpoint(state) {
    const gates = this.#state(state);
    for (let index = gates.checkpoints.length - 1; index >= 0; index -= 1) {
      if (gates.checkpoints[index].checkpointId === gates.currentCheckpointId) return gates.checkpoints[index];
    }
    return null;
  }

  authorityActors(checkpoint) {
    return checkpoint ? decisionAuthorityActors(this.#authorities, checkpoint.decisionClasses) : [];
  }

  async ensureCandidate({ state, workspace, snapshot, persist }) {
    const classification = classifySensitiveCandidate(snapshot.changedFiles, {
      architectureFileThreshold: this.#architectureFileThreshold,
      architectureOwnerThreshold: this.#architectureOwnerThreshold,
    });
    if (!classification.required) return { allowed: true, checkpoint: null, classification, subject: null };

    const now = this.#nowMs();
    const subject = await candidateArtifactSubject({
      worktreeDir: workspace.worktreeDir,
      baselineSha: workspace.baseSha,
      changedFiles: snapshot.changedFiles,
    });
    const gates = this.#state(state);
    let current = this.currentCheckpoint(state);

    if (current && current.subjectDigest !== subject.subjectDigest) {
      if (['pending', 'approved'].includes(current.state)) {
        current.state = 'superseded';
        current.supersededAt = nowIso(now);
        current.resolvedAt = current.supersededAt;
        state.prior.decisions.push(checkpointRecord(current, 'superseded', current.supersededAt));
      }
      gates.currentCheckpointId = null;
      await persist();
      current = null;
    }

    if (current && Date.parse(current.expiresAt) <= now) {
      if (['pending', 'approved'].includes(current.state)) {
        current.state = 'expired';
        current.resolvedAt = nowIso(now);
        state.prior.decisions.push(checkpointRecord(current, 'expired', current.resolvedAt));
        gates.currentCheckpointId = null;
        await persist();
      }
      current = null;
    }

    if (!current) {
      current = createHardGateCheckpoint({
        runId: state.runId,
        taskRevision: state.task.revision,
        baselineSha: workspace.baseSha,
        subjectDigest: subject.subjectDigest,
        decisionClasses: classification.decisionClasses,
        reasons: classification.reasons,
        changedFiles: classification.changedFiles,
        approvalTtlMs: this.#approvalTtlMs,
        nowMs: now,
      });
      current.authorizedActorCount = this.authorityActors(current).length;
      gates.checkpoints.push(current);
      gates.checkpoints = gates.checkpoints.slice(-32);
      gates.currentCheckpointId = current.checkpointId;
      state.prior.decisions.push(checkpointRecord(current, 'pending', current.createdAt));
      state.prior.decisions = state.prior.decisions.slice(-100);
      await persist();
    }

    if (current.state === 'approved' && current.subjectDigest === subject.subjectDigest && Date.parse(current.expiresAt) > now) {
      return { allowed: true, checkpoint: current, classification, subject };
    }
    return { allowed: false, checkpoint: current, classification, subject };
  }

  async poll({ state, issueNumber, persist }) {
    const gates = this.#state(state);
    const checkpoint = this.currentCheckpoint(state);
    if (!checkpoint || checkpoint.state !== 'pending') {
      return { status: 'no-pending-checkpoint', checkpoint, decision: null, rejected: [] };
    }
    const now = this.#nowMs();
    if (Date.parse(checkpoint.expiresAt) <= now) {
      checkpoint.state = 'expired';
      checkpoint.resolvedAt = nowIso(now);
      state.prior.decisions.push(checkpointRecord(checkpoint, 'expired', checkpoint.resolvedAt));
      state.prior.decisions = state.prior.decisions.slice(-100);
      gates.currentCheckpointId = null;
      await persist();
      return { status: 'expired', checkpoint, decision: null, rejected: [] };
    }

    const authorizedActorIds = this.authorityActors(checkpoint);
    if (!this.#source || authorizedActorIds.length === 0) {
      return {
        status: authorizedActorIds.length === 0 ? 'authority-unconfigured' : 'decision-source-unavailable',
        checkpoint,
        decision: null,
        rejected: [],
      };
    }

    const polled = await this.#source.pollWaitingDecision({
      issueNumber,
      runId: checkpoint.runId,
      taskRevision: checkpoint.taskRevision,
      checkpointId: checkpoint.checkpointId,
      subjectDigest: checkpoint.subjectDigest,
      authorizedActorIds,
      afterCommentId: gates.lastDecisionCommentId ?? 0,
    });

    const rejected = Array.isArray(polled.rejected) ? polled.rejected : [];
    if (rejected.length > 0) {
      const at = nowIso(now);
      state.prior.provenance.push(...rejected.map((entry) => rejectedDecisionRecord(entry, at)));
      state.prior.provenance = state.prior.provenance.slice(-100);
    }
    gates.lastDecisionCommentId = polled.highestCommentId ?? gates.lastDecisionCommentId ?? 0;

    if (!polled.decision) {
      await persist();
      return {
        status: polled.provenanceRetryRequired ? 'provenance-retry' : 'pending',
        checkpoint,
        decision: null,
        rejected,
      };
    }

    const match = decisionMatchesCheckpoint(checkpoint, polled.decision, { nowMs: now });
    if (!match.ok) {
      state.prior.provenance.push(rejectedDecisionRecord({
        commentId: polled.decision.commentId,
        actorId: polled.decision.actorId,
        reason: match.reason,
        contentSha256: polled.decision.contentSha256,
        provenance: polled.decision.provenance,
      }, nowIso(now)));
      state.prior.provenance = state.prior.provenance.slice(-100);
      await persist();
      return { status: 'pending', checkpoint, decision: null, rejected: [...rejected, { reason: match.reason }] };
    }

    const decision = polled.decision;
    checkpoint.state = decision.action === 'approve'
      ? 'approved'
      : decision.action === 'reject'
        ? 'rejected'
        : 'redirected';
    checkpoint.resolvedAt = nowIso(now);
    checkpoint.decision = {
      action: decision.action,
      actorId: decision.actorId,
      commentId: decision.commentId,
      contentSha256: decision.contentSha256,
      subjectDigest: decision.subjectDigest,
      provenance: provenanceProjection(decision.provenance),
      instructions: decision.instructions ?? null,
      acceptedAt: checkpoint.resolvedAt,
    };
    state.prior.decisions.push({
      source: 'trusted-decision',
      action: decision.action,
      actorId: decision.actorId,
      commentId: decision.commentId,
      checkpointId: checkpoint.checkpointId,
      subjectDigest: checkpoint.subjectDigest,
      decisionClasses: [...checkpoint.decisionClasses],
      contentSha256: decision.contentSha256,
      contentProvenance: provenanceProjection(decision.provenance),
      instructions: decision.instructions ?? null,
      recordedAt: checkpoint.resolvedAt,
    });
    state.prior.decisions = state.prior.decisions.slice(-100);
    state.prior.provenance.push(acceptedDecisionRecord(decision, checkpoint, checkpoint.resolvedAt));
    state.prior.provenance = state.prior.provenance.slice(-100);
    await persist();
    return { status: checkpoint.state, checkpoint, decision, rejected };
  }
}
