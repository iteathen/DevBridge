import { buildCandidateArtifactSubject, checkpointIdForDecision, classifyCandidateDecision } from './candidate-subject.js';

function nowIso(now) {
  return new Date(now()).toISOString();
}

export class CandidateDecisionGate {
  #workspace;
  #source;
  #expiryMs;
  #now;

  constructor({ workspaceManager, decisionSource, expiryMs = 86_400_000, now = () => Date.now() }) {
    this.#workspace = workspaceManager;
    this.#source = decisionSource;
    this.#expiryMs = expiryMs;
    this.#now = now;
  }

  async #currentSubject(task, workspace) {
    const snapshot = await this.#workspace.validate(workspace);
    const artifact = await buildCandidateArtifactSubject(workspace, snapshot);
    const decision = classifyCandidateDecision(artifact);
    if (!decision) return { snapshot, artifact, decision: null, checkpointId: null };
    return {
      snapshot,
      artifact,
      decision,
      checkpointId: checkpointIdForDecision(workspace.runId, task.revision, decision),
    };
  }

  async evaluate({ state, task, workspace, persist }) {
    const current = await this.#currentSubject(task, workspace);
    if (!current.decision) {
      if (state.decisionGate?.state === 'pending') {
        state.decisionGate.state = 'superseded';
        state.decisionGate.supersededAt = nowIso(this.#now);
        await persist();
      }
      return { required: false, authorized: true, snapshot: current.snapshot, artifactDigest: current.artifact.digest };
    }

    const expected = {
      protocol: 'patch-poller/checkpoint-v1',
      checkpointId: current.checkpointId,
      runId: workspace.runId,
      taskRevision: task.revision,
      repository: workspace.repository,
      baselineSha: workspace.baseSha,
      decisionClass: current.decision.decisionClass,
      bindingMode: current.decision.bindingMode,
      subjectDigest: current.decision.subjectDigest,
      artifactDigest: current.artifact.digest,
      decisionScopeDigest: current.decision.scopeDigest,
      risks: current.decision.risks,
      paths: current.decision.paths,
      gatedEffect: 'seal-and-publish-candidate',
    };

    let checkpoint = state.decisionGate ?? null;
    const sameIdentity = checkpoint &&
      checkpoint.checkpointId === expected.checkpointId &&
      checkpoint.subjectDigest === expected.subjectDigest &&
      checkpoint.decisionClass === expected.decisionClass &&
      checkpoint.bindingMode === expected.bindingMode;
    const reusableState = sameIdentity && !['expired', 'superseded'].includes(checkpoint.state);

    if (!reusableState) {
      const previousHighWater = checkpoint?.lastDecisionCommentId ?? 0;
      if (checkpoint) {
        if (!['superseded', 'expired'].includes(checkpoint.state)) {
          checkpoint.state = 'superseded';
          checkpoint.supersededAt = nowIso(this.#now);
        }
        state.decisionHistory ??= [];
        state.decisionHistory.push(structuredClone(checkpoint));
      }
      const createdAtMs = this.#now();
      checkpoint = {
        ...expected,
        state: 'pending',
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + this.#expiryMs).toISOString(),
        lastDecisionCommentId: previousHighWater,
        acceptedDecision: null,
      };
      state.decisionGate = checkpoint;
      await persist();
    } else {
      checkpoint.artifactDigest = expected.artifactDigest;
      checkpoint.paths = expected.paths;
      checkpoint.risks = expected.risks;
      await persist();
    }

    if (checkpoint.state === 'approved') {
      return {
        required: true,
        authorized: true,
        checkpoint,
        snapshot: current.snapshot,
        artifactDigest: current.artifact.digest,
      };
    }
    if (checkpoint.state === 'rejected' || checkpoint.state === 'redirected') {
      return { required: true, authorized: false, terminal: checkpoint.state === 'rejected', checkpoint, snapshot: current.snapshot };
    }
    if (this.#now() >= Date.parse(checkpoint.expiresAt)) {
      checkpoint.state = 'expired';
      checkpoint.expiredAt = nowIso(this.#now);
      await persist();
      return { required: true, authorized: false, expired: true, checkpoint, snapshot: current.snapshot };
    }

    const polled = await this.#source.pollCheckpoint({
      issueNumber: task.issueNumber,
      checkpoint,
      afterCommentId: checkpoint.lastDecisionCommentId ?? 0,
      now: this.#now(),
    });
    checkpoint.lastDecisionCommentId = polled.highestCommentId ?? checkpoint.lastDecisionCommentId ?? 0;
    if (!polled.decision) {
      await persist();
      return { required: true, authorized: false, pending: true, checkpoint, snapshot: current.snapshot, reason: polled.reason };
    }

    checkpoint.acceptedDecision = polled.decision;
    checkpoint.decidedAt = polled.decision.createdAt ?? nowIso(this.#now);
    if (polled.decision.action === 'approve') checkpoint.state = 'approved';
    else if (polled.decision.action === 'reject') checkpoint.state = 'rejected';
    else checkpoint.state = 'redirected';
    await persist();
    return {
      required: true,
      authorized: checkpoint.state === 'approved',
      terminal: checkpoint.state === 'rejected',
      redirected: checkpoint.state === 'redirected',
      checkpoint,
      snapshot: current.snapshot,
    };
  }

  async verifyAuthorized({ state, task, workspace, persist }) {
    const result = await this.evaluate({ state, task, workspace, persist });
    return result.authorized === true ? result : { ...result, authorized: false };
  }
}
