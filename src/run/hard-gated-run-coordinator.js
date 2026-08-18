import { buildContextCapsule } from '../context/context-capsule.js';
import { DecisionGatePendingError, DecisionGateResolvedError } from './decision-gated-workspace-manager.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class HardGatedRunCoordinator {
  #delegate; #store; #workspace; #reporter; #queueRepository;

  constructor({ delegate, stateStore, workspaceManager, statusReporter = null, queueRepository }) {
    this.#delegate = delegate; this.#store = stateStore; this.#workspace = workspaceManager; this.#reporter = statusReporter; this.#queueRepository = queueRepository;
  }

  #key(task) { return `run.${this.#queueRepository}#${task.issueNumber}.${task.revision}`; }
  async #save(key, state) { state.updatedAt = new Date().toISOString(); await this.#store.set(key, state); }

  #result(state, checkpoint, status) {
    return { runId: state.runId, issueNumber: state.task.issueNumber, status, waiting: true, checkpoint: { checkpointId: checkpoint.checkpointId, decisionClass: checkpoint.decisionClass, bindingMode: checkpoint.bindingMode, subjectDigest: checkpoint.subjectDigest, state: checkpoint.state, expiresAt: checkpoint.expiresAt, sensitivePaths: checkpoint.sensitivePaths } };
  }

  async #recordGate(task, error) {
    const key = this.#key(task);
    const state = await this.#store.get(key);
    if (!state) throw error;
    const checkpoint = error.checkpoint;
    const pending = error instanceof DecisionGatePendingError;
    state.stage = pending ? 'hard-gate-pending' : 'waiting-decision';
    state.decisionGate = { checkpointId: checkpoint.checkpointId, decisionClass: checkpoint.decisionClass, bindingMode: checkpoint.bindingMode, subjectDigest: checkpoint.subjectDigest, artifactDigest: checkpoint.artifactDigest ?? null, state: checkpoint.state, expiresAt: checkpoint.expiresAt, sensitivePaths: checkpoint.sensitivePaths, rationale: checkpoint.rationale ?? null, decision: checkpoint.decision ?? null };
    state.prior ??= { decisions: [], progress: [], blockers: [] };
    state.prior.decisions ??= [];
    state.prior.decisions = [...state.prior.decisions.filter((entry) => entry?.checkpointId !== checkpoint.checkpointId), { checkpointId: checkpoint.checkpointId, decisionClass: checkpoint.decisionClass, bindingMode: checkpoint.bindingMode, subjectDigest: checkpoint.subjectDigest, state: checkpoint.state, decision: checkpoint.decision ?? null }].slice(-32);
    state.prior.blockers = [error.message];
    await this.#save(key, state);
    if (this.#reporter) {
      try {
        await this.#reporter.publish({ issueNumber: task.issueNumber, runId: state.runId, revision: task.revision, stage: pending ? 'HARD_GATE_PENDING' : 'WAITING_DECISION', summary: error.message, capsule: buildContextCapsule({ task: state.task, sequence: Math.max(1, (state.turn ?? 0) + 1), prior: state.prior, runtime: { changedFiles: state.prior.changedFiles ?? [], tests: state.prior.tests ?? [], git: state.prior.git ?? null, blockers: state.prior.blockers, nextStep: state.prior.nextStep ?? null, outputTail: state.prior.outputTail ?? null, receipt: state.prior.receipt ?? null, liveness: state.prior.liveness ?? null } }), force: true, terminal: false });
      } catch {}
    }
    return this.#result(state, checkpoint, pending ? 'hard-gate-pending' : 'waiting-decision');
  }

  async #resumeGate(task, state) {
    if (state.stage === 'waiting-decision') return this.#result(state, state.decisionGate, 'waiting-decision');
    const plan = task.envelope?.controllerPlan ?? null;
    const workspace = await this.#workspace.prepareRun(task, state.runId, {
      baseRef: state.workspace?.baseRef ?? null,
      baseSha: state.workspace?.baseSha ?? null,
      baselineChannel: state.workspace?.baselineChannel ?? plan?.baselineChannel ?? null,
    });
    try {
      const gate = await this.#workspace.assertDecisionGate(workspace, { issueNumber: task.issueNumber, revision: task.revision });
      state.stage = 'verifying';
      state.decisionGate = { ...state.decisionGate, state: gate.checkpoint?.state ?? 'approved', decision: gate.checkpoint?.decision ?? null };
      state.prior.blockers = [];
      await this.#save(this.#key(task), state);
      return null;
    } catch (error) {
      if (error instanceof DecisionGatePendingError || error instanceof DecisionGateResolvedError) return this.#recordGate(task, error);
      throw error;
    }
  }

  async executeTask(task) {
    const state = await this.#store.get(this.#key(task));
    if (state?.stage === 'hard-gate-pending' || state?.stage === 'waiting-decision') {
      const waiting = await this.#resumeGate(task, state);
      if (waiting) return waiting;
    }
    try { return await this.#delegate.executeTask(task); }
    catch (error) {
      if (error instanceof DecisionGatePendingError || error instanceof DecisionGateResolvedError) return this.#recordGate(task, error);
      throw error;
    }
  }

  async resumePending() {
    const entries = await this.#store.entries(`run.${this.#queueRepository}#`);
    const pending = entries.map(([, value]) => value).filter((state) => state?.task && !TERMINAL.has(state.stage)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return pending.length ? this.executeTask(pending[0].task) : null;
  }
}
