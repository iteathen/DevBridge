import { candidateArtifactDigest } from './candidate-artifact-digest.js';
import { checkpointIdFor, classifySensitiveCandidate, decisionIsAccepted, decisionSubjectDigest } from './decision-gate.js';

function nowIso(nowMs) { return new Date(nowMs()).toISOString(); }
function isExpired(checkpoint, nowMs) { return checkpoint?.expiresAt != null && Date.parse(checkpoint.expiresAt) <= nowMs(); }

export class DecisionGatePendingError extends Error {
  constructor(message, checkpoint) { super(message); this.name = 'DecisionGatePendingError'; this.checkpoint = checkpoint; }
}

export class DecisionGateResolvedError extends Error {
  constructor(message, checkpoint) { super(message); this.name = 'DecisionGateResolvedError'; this.checkpoint = checkpoint; }
}

export class DecisionGatedWorkspaceManager {
  #delegate; #store; #feedback; #queueRepository; #policy; #nowMs;

  constructor({ delegate, stateStore, feedbackSource, queueRepository, decisionPolicy, nowMs = () => Date.now() }) {
    this.#delegate = delegate; this.#store = stateStore; this.#feedback = feedbackSource; this.#queueRepository = queueRepository; this.#policy = decisionPolicy; this.#nowMs = nowMs;
  }

  #decisionKey(workspace) { return `decision.${this.#queueRepository}#${workspace.runId}`; }
  #sealKey(workspace) { return `seal.${this.#queueRepository}#${workspace.runId}`; }

  async #load(workspace, issueNumber, taskRevision) {
    const key = this.#decisionKey(workspace);
    let state = await this.#store.get(key);
    if (!state) state = { version: 1, runId: workspace.runId, issueNumber, taskRevision, checkpoints: [], lastCommentId: 0, createdAt: nowIso(this.#nowMs) };
    if (state.issueNumber !== issueNumber || state.taskRevision !== taskRevision) throw new Error('persisted decision state does not match the active task identity');
    return { key, state };
  }

  async #save(key, state) { state.updatedAt = nowIso(this.#nowMs); await this.#store.set(key, state); }

  async assertDecisionGate(workspace, { issueNumber, revision }) {
    const snapshot = await this.#delegate.validate(workspace);
    const classification = classifySensitiveCandidate(snapshot.changedFiles);
    if (!classification) return { allowed: true, checkpoint: null, snapshot, classification: null, artifact: null };

    const artifact = await candidateArtifactDigest({ baseSha: snapshot.baseSha, worktreeDir: workspace.worktreeDir, changedFiles: snapshot.changedFiles });
    const subjectDigest = decisionSubjectDigest({ bindingMode: classification.bindingMode, artifactDigest: artifact.artifactSha256 });
    const { key, state } = await this.#load(workspace, issueNumber, revision);

    const prior = [...state.checkpoints].reverse().find((entry) => entry.decisionClass === classification.decisionClass && entry.state !== 'superseded');
    let checkpoint = prior?.subjectDigest === subjectDigest ? prior : null;
    if (prior && prior.subjectDigest !== subjectDigest) {
      prior.state = 'superseded';
      prior.supersededAt = nowIso(this.#nowMs);
      prior.supersededBySubjectDigest = subjectDigest;
      checkpoint = null;
    }
    if (!checkpoint) {
      checkpoint = {
        protocol: 'patch-poller/checkpoint-v1',
        checkpointId: checkpointIdFor({ runId: workspace.runId, taskRevision: revision, decisionClass: classification.decisionClass, bindingMode: classification.bindingMode, subjectDigest }),
        runId: workspace.runId,
        taskRevision: revision,
        decisionClass: classification.decisionClass,
        bindingMode: classification.bindingMode,
        subjectDigest,
        artifactDigest: artifact.artifactSha256,
        sensitivePaths: classification.sensitivePaths,
        rationale: classification.rationale,
        state: 'pending',
        createdAt: nowIso(this.#nowMs),
        expiresAt: new Date(this.#nowMs() + this.#policy.checkpointTtlMs).toISOString(),
      };
      state.checkpoints.push(checkpoint);
      await this.#save(key, state);
    }

    if (isExpired(checkpoint, this.#nowMs)) {
      if (checkpoint.state !== 'expired') {
        checkpoint.state = 'expired'; checkpoint.expiredAt = nowIso(this.#nowMs); await this.#save(key, state);
      }
      throw new DecisionGatePendingError(`Hard gate ${checkpoint.checkpointId} expired without current approval; silence is not approval.`, checkpoint);
    }
    if (checkpoint.state === 'approved') return { allowed: true, checkpoint, snapshot, classification, artifact };
    if (['rejected', 'redirected'].includes(checkpoint.state)) throw new DecisionGateResolvedError(`Hard gate ${checkpoint.checkpointId} is ${checkpoint.state}; the current candidate cannot be sealed.`, checkpoint);
    if (checkpoint.state === 'expired') throw new DecisionGatePendingError(`Hard gate ${checkpoint.checkpointId} is expired and cannot authorize sealing.`, checkpoint);

    if (this.#feedback?.pollDecision) {
      const polled = await this.#feedback.pollDecision({ issueNumber, runId: workspace.runId, taskRevision: revision, checkpointId: checkpoint.checkpointId, subjectDigest: checkpoint.subjectDigest, afterCommentId: state.lastCommentId ?? 0 });
      state.lastCommentId = Math.max(state.lastCommentId ?? 0, polled.highestCommentId ?? 0);
      if (polled.rejected?.length) state.rejectedInputs = [...(state.rejectedInputs ?? []), ...polled.rejected].slice(-32);
      if (polled.decision) {
        const allowedActors = new Set(this.#policy.authorityClasses[checkpoint.decisionClass] ?? []);
        const match = decisionIsAccepted({ checkpoint, decision: polled.decision, allowedActorIds: allowedActors, nowMs: this.#nowMs() });
        if (!match.accepted) {
          state.rejectedDecisions = [...(state.rejectedDecisions ?? []), { commentId: polled.decision.commentId, reason: match.reason, at: nowIso(this.#nowMs) }].slice(-32);
          await this.#save(key, state);
        } else if (polled.decision.action === 'approve') {
          checkpoint.state = 'approved'; checkpoint.approvedAt = nowIso(this.#nowMs);
          checkpoint.decision = { action: 'approve', commentId: polled.decision.commentId, actorId: polled.decision.actorId, actorLogin: polled.decision.actorLogin, provenanceSha256: polled.decision.authorityProvenance?.provenanceSha256 ?? null };
          await this.#save(key, state);
          return { allowed: true, checkpoint, snapshot, classification, artifact };
        } else {
          checkpoint.state = polled.decision.action === 'reject' ? 'rejected' : 'redirected'; checkpoint.resolvedAt = nowIso(this.#nowMs);
          checkpoint.decision = { action: polled.decision.action, instructions: polled.decision.instructions ?? null, commentId: polled.decision.commentId, actorId: polled.decision.actorId, actorLogin: polled.decision.actorLogin, provenanceSha256: polled.decision.authorityProvenance?.provenanceSha256 ?? null };
          await this.#save(key, state);
          throw new DecisionGateResolvedError(`Hard gate ${checkpoint.checkpointId} was ${checkpoint.state}; the current candidate cannot be sealed.`, checkpoint);
        }
      } else {
        await this.#save(key, state);
      }
    }

    throw new DecisionGatePendingError(`Sensitive candidate is complete through reversible verification but hard gate ${checkpoint.checkpointId} requires exact approval of ${checkpoint.subjectDigest}.`, checkpoint);
  }

  async prepareRun(...args) { return this.#delegate.prepareRun(...args); }
  async snapshot(...args) { return this.#delegate.snapshot(...args); }
  async validate(...args) { return this.#delegate.validate(...args); }

  async sealCandidate(workspace, options) {
    const gate = await this.assertDecisionGate(workspace, options);
    if (!gate.snapshot.dirty) return gate.snapshot;

    if (gate.classification) {
      const immediatelyBeforeSeal = await candidateArtifactDigest({ baseSha: gate.snapshot.baseSha, worktreeDir: workspace.worktreeDir, changedFiles: gate.snapshot.changedFiles });
      if (immediatelyBeforeSeal.artifactSha256 !== gate.artifact.artifactSha256) {
        throw new DecisionGatePendingError('Candidate changed after artifact-exact approval and before sealing; a new exact approval is required.', gate.checkpoint);
      }
    }

    const sealed = await this.#delegate.sealCandidate(workspace, options);
    if (gate.classification) {
      const sealedArtifact = await candidateArtifactDigest({ baseSha: gate.snapshot.baseSha, worktreeDir: workspace.worktreeDir, changedFiles: gate.snapshot.changedFiles });
      if (sealedArtifact.artifactSha256 !== gate.artifact.artifactSha256) {
        throw new DecisionGateResolvedError('Sealed candidate bytes differ from the artifact-exact approval; publication is prohibited.', gate.checkpoint);
      }
    }

    await this.#store.set(this.#sealKey(workspace), {
      version: 1,
      runId: workspace.runId,
      baseSha: sealed.baseSha,
      candidateSha: sealed.headSha,
      sensitive: Boolean(gate.classification),
      checkpointId: gate.checkpoint?.checkpointId ?? null,
      subjectDigest: gate.checkpoint?.subjectDigest ?? null,
      artifactDigest: gate.artifact?.artifactSha256 ?? null,
      sealedAt: nowIso(this.#nowMs),
    });
    return sealed;
  }

  async publishTaskBranch(workspace) {
    const snapshot = await this.#delegate.validate(workspace);
    if (snapshot.dirty) return this.#delegate.publishTaskBranch(workspace);
    if (snapshot.headSha === snapshot.baseSha) return this.#delegate.publishTaskBranch(workspace);

    const seal = await this.#store.get(this.#sealKey(workspace));
    if (!seal || seal.runId !== workspace.runId || seal.baseSha !== snapshot.baseSha || seal.candidateSha !== snapshot.headSha) {
      const checkpoint = { checkpointId: 'unbound-publication', decisionClass: 'security-change', bindingMode: 'artifact-exact', subjectDigest: null, state: 'pending', expiresAt: null, sensitivePaths: [] };
      throw new DecisionGatePendingError('Publication is blocked because the current candidate commit was not produced by this run through the decision-aware seal boundary.', checkpoint);
    }
    if (seal.sensitive) {
      const state = await this.#store.get(this.#decisionKey(workspace));
      const approved = (state?.checkpoints ?? []).find((entry) => entry.checkpointId === seal.checkpointId && entry.state === 'approved' && entry.subjectDigest === seal.subjectDigest);
      if (!approved || isExpired(approved, this.#nowMs)) {
        throw new DecisionGatePendingError('Sensitive candidate publication requires a current exact approved checkpoint bound to the sealed commit.', approved ?? { checkpointId: seal.checkpointId, decisionClass: 'security-change', bindingMode: 'artifact-exact', subjectDigest: seal.subjectDigest, state: 'pending', expiresAt: null, sensitivePaths: [] });
      }
    }
    return this.#delegate.publishTaskBranch(workspace);
  }
}

export function decisionGatedWorkspaceManager(options) {
  const gate = new DecisionGatedWorkspaceManager(options);
  return new Proxy(gate, {
    get(target, prop) {
      if (prop in target) {
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const value = options.delegate[prop];
      return typeof value === 'function' ? value.bind(options.delegate) : value;
    },
  });
}
