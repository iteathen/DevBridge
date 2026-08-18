import { buildContextCapsule } from '../context/context-capsule.js';
import { PolicyError } from '../errors.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function nowIso() {
  return new Date().toISOString();
}

export class DecisionRequiredError extends PolicyError {
  constructor(checkpoint) {
    super(`hard gate ${checkpoint?.checkpointId ?? 'unknown'} requires an exact trusted decision before candidate sealing`);
    this.checkpoint = checkpoint ? structuredClone(checkpoint) : null;
  }
}

export class DecisionGatedWorkspaceManager {
  #delegate;
  #store;
  #queueRepository;
  #gate;

  constructor({ delegate, stateStore, queueRepository, gateController }) {
    this.#delegate = delegate;
    this.#store = stateStore;
    this.#queueRepository = queueRepository;
    this.#gate = gateController;
  }

  #key(issueNumber, revision) {
    return `run.${this.#queueRepository}#${issueNumber}.${revision}`;
  }

  prepareRun(...args) { return this.#delegate.prepareRun(...args); }
  snapshot(...args) { return this.#delegate.snapshot(...args); }
  validate(...args) { return this.#delegate.validate(...args); }
  publishTaskBranch(...args) { return this.#delegate.publishTaskBranch(...args); }

  async sealCandidate(workspace, { issueNumber, revision }) {
    const key = this.#key(issueNumber, revision);
    const state = await this.#store.get(key);
    if (!state?.task || state.runId == null) {
      throw new PolicyError('hard-gated candidate sealing requires durable run state');
    }
    const snapshot = await this.#delegate.validate(workspace);
    const gate = await this.#gate.ensureCandidate({
      state,
      workspace,
      snapshot,
      persist: () => this.#store.set(key, state),
    });
    if (!gate.allowed) throw new DecisionRequiredError(gate.checkpoint);

    // The exact artifact subject was recomputed immediately before this call.
    // No proposal engine or repository-controlled operation runs between this
    // verification and the control-plane-owned Git sealing transaction.
    return this.#delegate.sealCandidate(workspace, { issueNumber, revision });
  }
}

export class DecisionGatedRunCoordinator {
  #delegate;
  #store;
  #reporter;
  #gate;
  #queueRepository;
  #maxTurns;

  constructor({
    delegate,
    stateStore,
    statusReporter = null,
    gateController,
    queueRepository,
    maxTurns = 8,
  }) {
    this.#delegate = delegate;
    this.#store = stateStore;
    this.#reporter = statusReporter;
    this.#gate = gateController;
    this.#queueRepository = queueRepository;
    this.#maxTurns = maxTurns;
  }

  #key(task) {
    return `run.${this.#queueRepository}#${task.issueNumber}.${task.revision}`;
  }

  async #save(key, state) {
    state.updatedAt = nowIso();
    await this.#store.set(key, state);
  }

  #capsule(state) {
    return buildContextCapsule({
      task: state.task,
      sequence: Math.max(1, (state.turn ?? 0) + 1),
      prior: state.prior,
      runtime: {
        changedFiles: state.prior?.changedFiles ?? [],
        tests: state.prior?.tests ?? [],
        git: state.prior?.git ?? null,
        blockers: state.prior?.blockers ?? [],
        nextStep: state.prior?.nextStep ?? null,
        outputTail: state.prior?.outputTail ?? null,
        receipt: state.prior?.receipt ?? null,
        liveness: state.prior?.liveness ?? null,
      },
    });
  }

  async #publish(state, stage, summary, { terminal = false } = {}) {
    if (!this.#reporter) return null;
    try {
      return await this.#reporter.publish({
        issueNumber: state.task.issueNumber,
        runId: state.runId,
        revision: state.task.revision,
        stage,
        summary,
        capsule: this.#capsule(state),
        terminal,
        force: true,
      });
    } catch (error) {
      state.statusError = { name: error.name, message: error.message, at: nowIso() };
      return null;
    }
  }

  #waitingResult(state, checkpoint) {
    return {
      runId: state.runId,
      issueNumber: state.task.issueNumber,
      status: 'waiting-decision',
      waiting: true,
      checkpointId: checkpoint?.checkpointId ?? null,
      subjectDigest: checkpoint?.subjectDigest ?? null,
      decisionClasses: checkpoint?.decisionClasses ?? [],
      expiresAt: checkpoint?.expiresAt ?? null,
      authorizedActorCount: checkpoint?.authorizedActorCount ?? 0,
      branch: state.workspace?.branch ?? null,
    };
  }

  async #enterWaitingDecision(key, state, checkpoint) {
    state.stage = 'waiting-decision';
    state.prior ??= {};
    state.prior.blockers = [
      checkpoint
        ? `Hard gate ${checkpoint.checkpointId} is pending for exact artifact ${checkpoint.subjectDigest}; approval must match the run, task revision, checkpoint, subject digest, and locally configured decision authority.`
        : 'A sensitive candidate requires a matching PP-007 hard-gate decision before sealing.',
    ];
    state.prior.nextStep = null;
    state.prior.liveness = null;
    await this.#save(key, state);
    const classes = checkpoint?.decisionClasses?.join(', ') || 'sensitive-change';
    const authority = checkpoint?.authorizedActorCount > 0
      ? `${checkpoint.authorizedActorCount} locally authorized actor(s) can decide all triggered classes.`
      : 'No remote actor is locally authorized for every triggered decision class; local policy must be updated before remote approval can succeed.';
    await this.#publish(
      state,
      'HARD_GATE_PENDING',
      `Candidate sealing is blocked by hard gate ${checkpoint?.checkpointId ?? 'unknown'} (${classes}). ${authority}`,
    );
    return this.#waitingResult(state, checkpoint);
  }

  async #handleWaitingDecision(task, key, state) {
    const polled = await this.#gate.poll({
      state,
      issueNumber: task.issueNumber,
      persist: () => this.#save(key, state),
    });

    if (['pending', 'provenance-retry', 'authority-unconfigured', 'decision-source-unavailable'].includes(polled.status)) {
      state.stage = 'waiting-decision';
      await this.#save(key, state);
      if (polled.rejected.length > 0 || polled.status !== 'pending') {
        const suffix = polled.status === 'provenance-retry'
          ? ' Exact decision provenance is temporarily unverifiable; the decision cursor was not advanced.'
          : polled.status === 'authority-unconfigured'
            ? ' No locally configured actor is authorized for all triggered decision classes.'
            : polled.status === 'decision-source-unavailable'
              ? ' The trusted decision source is unavailable.'
              : ` ${polled.rejected.length} authority-shaped decision comment(s) were rejected.`;
        await this.#publish(state, 'HARD_GATE_PENDING', `Hard gate ${polled.checkpoint.checkpointId} remains pending.${suffix}`);
      }
      return this.#waitingResult(state, polled.checkpoint);
    }

    if (polled.status === 'approved') {
      state.stage = 'verifying';
      state.prior.blockers = [];
      state.prior.nextStep = null;
      await this.#save(key, state);
      await this.#publish(state, 'DECISION_ACCEPTED', `Exact approval accepted for hard gate ${polled.checkpoint.checkpointId}; PATCH-POLLER will recompute the artifact subject before sealing.`);
      return null;
    }

    if (polled.status === 'expired' || polled.status === 'no-pending-checkpoint') {
      state.stage = 'verifying';
      state.prior.blockers = [];
      await this.#save(key, state);
      return null;
    }

    if (polled.status === 'rejected' || polled.status === 'redirected') {
      if (state.decisionGates) state.decisionGates.currentCheckpointId = null;
      if (task.envelope.controllerPlan) {
        state.stage = 'failed';
        state.error = {
          classification: polled.status === 'rejected' ? 'DECISION_REJECTED' : 'DECISION_REDIRECTED',
          message: polled.status === 'rejected'
            ? `Hard gate ${polled.checkpoint.checkpointId} was rejected; immutable controller plan will not be sealed.`
            : `Hard gate ${polled.checkpoint.checkpointId} was redirected; immutable controller plan requires a new task revision/plan.`,
          at: nowIso(),
        };
        state.prior.blockers = [state.error.message];
        state.prior.nextStep = null;
        await this.#save(key, state);
        await this.#publish(state, polled.status === 'rejected' ? 'DECISION_REJECTED' : 'DECISION_REDIRECTED', state.error.message, { terminal: true });
        return {
          runId: state.runId,
          issueNumber: task.issueNumber,
          status: 'failed',
          branch: state.workspace?.branch ?? null,
          error: state.error,
        };
      }

      state.stage = 'running';
      state.prior.blockers = [];
      state.prior.nextStep = polled.status === 'redirected'
        ? `Human decision redirected the gated candidate. Follow this bounded direction without crossing the rejected exact artifact subject: ${polled.decision?.instructions ?? 'produce a materially different safe candidate.'}`
        : 'Human decision rejected the gated candidate. Produce a materially different architecture-preserving alternative; do not attempt to seal the rejected exact artifact again.';
      state.turnLimit = Math.max(state.turnLimit ?? 0, (state.turn ?? 0) + this.#maxTurns);
      await this.#save(key, state);
      await this.#publish(state, polled.status === 'redirected' ? 'DECISION_REDIRECTED' : 'DECISION_REJECTED', state.prior.nextStep);
      return null;
    }

    throw new PolicyError(`unexpected hard-gate decision status ${polled.status}`);
  }

  async executeTask(task) {
    const key = this.#key(task);
    let state = await this.#store.get(key);
    if (state?.stage === 'waiting-decision') {
      const waiting = await this.#handleWaitingDecision(task, key, state);
      if (waiting) return waiting;
      state = await this.#store.get(key);
      if (TERMINAL.has(state?.stage)) {
        return { runId: state.runId, issueNumber: task.issueNumber, status: state.stage, skipped: true };
      }
    }

    try {
      return await this.#delegate.executeTask(task);
    } catch (error) {
      if (!(error instanceof DecisionRequiredError)) throw error;
      state = await this.#store.get(key);
      if (!state?.task) throw error;
      return this.#enterWaitingDecision(key, state, error.checkpoint);
    }
  }

  async resumePending() {
    const entries = await this.#store.entries(`run.${this.#queueRepository}#`);
    const pending = entries
      .map(([, value]) => value)
      .filter((state) => state?.task && !TERMINAL.has(state.stage))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (pending.length === 0) return null;
    return this.executeTask(pending[0].task);
  }
}
