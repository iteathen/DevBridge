import { buildContextCapsule } from '../context/context-capsule.js';
import { CandidateValidationError, PolicyError } from '../errors.js';
import { validateToolProfile } from '../runtime/cli-profile.js';
import { controllerPlanDigest } from './controller-plan.js';
import { parseToolResult } from './result-envelope.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TRANSIENT_RETRY_BASE_MS = 5_000;
const TRANSIENT_RETRY_MAX_MS = 60_000;

function nowIso() { return new Date().toISOString(); }
function defaultSleep(ms) { return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)); }
function transientRetryDelay(attempt) {
  const exponent = Math.max(0, Math.min(20, attempt - 1));
  return Math.min(TRANSIENT_RETRY_MAX_MS, TRANSIENT_RETRY_BASE_MS * (2 ** exponent));
}
function outputTail(run) {
  const text = [run.stdout, run.stderr].filter(Boolean).join('\n');
  return text.length <= 8000 ? text : text.slice(-8000);
}
export function runIdForTask(task) { return `pp-${task.issueNumber}-${task.revision.slice(0, 16)}`; }

export class RunCoordinator {
  #store; #workspace; #runner; #planExecutor; #reporter; #feedback; #decisionGate; #toolInventory;
  #queueRepository; #tools; #defaultTool; #maxTurns; #allowUncontainedTools; #controllerPlansEnabled;
  #modelAdaptersEnabled; #deterministicProfileNames; #autoPush; #forceNoOpPublication; #nowMs; #sleep;

  constructor({
    stateStore,
    workspaceManager,
    processRunner,
    controllerPlanExecutor = null,
    statusReporter = null,
    feedbackSource = null,
    decisionGate = null,
    toolInventory = null,
    queueRepository,
    tools,
    defaultTool = null,
    maxTurns = 8,
    allowUncontainedTools = false,
    controllerPlansEnabled = true,
    modelAdaptersEnabled = true,
    deterministicProfileNames = [],
    autoPushTaskBranches = false,
    forceNoOpPublication = false,
    nowMs = () => Date.now(),
    sleep = defaultSleep
  }) {
    this.#store = stateStore;
    this.#workspace = workspaceManager;
    this.#runner = processRunner;
    this.#planExecutor = controllerPlanExecutor;
    this.#reporter = statusReporter;
    this.#feedback = feedbackSource;
    this.#decisionGate = decisionGate;
    this.#toolInventory = toolInventory;
    this.#queueRepository = queueRepository;
    this.#tools = tools;
    this.#defaultTool = defaultTool;
    this.#maxTurns = maxTurns;
    this.#allowUncontainedTools = allowUncontainedTools;
    this.#controllerPlansEnabled = controllerPlansEnabled === true;
    this.#modelAdaptersEnabled = modelAdaptersEnabled === true;
    this.#deterministicProfileNames = new Set(deterministicProfileNames);
    this.#autoPush = autoPushTaskBranches;
    this.#forceNoOpPublication = forceNoOpPublication === true;
    this.#nowMs = nowMs;
    this.#sleep = sleep;
  }

  #key(task) { return `run.${this.#queueRepository}#${task.issueNumber}.${task.revision}`; }
  async #save(key, state) { state.updatedAt = nowIso(); await this.#store.set(key, state); }

  #selectProfile(task) {
    const preferred = task.envelope.preferredTool;
    const name = preferred && Object.hasOwn(this.#tools, preferred) ? preferred : this.#defaultTool;
    if (!this.#modelAdaptersEnabled && !this.#deterministicProfileNames.has(name)) {
      throw new PolicyError('coding-model adapters are disabled by local policy; submit a controller plan or explicitly enable a compatibility adapter');
    }
    if (!name || !Object.hasOwn(this.#tools, name)) throw new PolicyError(`no locally configured coding tool is available for task ${task.issueNumber}`);
    return validateToolProfile(name, this.#tools[name], { allowUncontainedTools: this.#allowUncontainedTools });
  }

  #capsule(state, snapshot = null) {
    const inventory = this.#toolInventory?.current?.() ?? null;
    return buildContextCapsule({
      task: state.task,
      sequence: Math.max(1, state.turn + 1),
      prior: state.prior,
      runtime: {
        changedFiles: snapshot?.changedFiles ?? state.prior.changedFiles,
        tests: state.prior.tests,
        git: snapshot ? { branch: snapshot.branch, baseSha: snapshot.baseSha, headSha: snapshot.headSha, dirty: snapshot.dirty } : state.prior.git,
        blockers: state.prior.blockers,
        nextStep: state.prior.nextStep,
        outputTail: state.prior.outputTail,
        receipt: state.prior.receipt ?? null,
        liveness: state.prior.liveness ?? null,
        toolInventory: inventory ? { digest: inventory.digest, generation: inventory.generation } : null,
      }
    });
  }

  async #publish(state, stage, summary, snapshot = null, { terminal = false, force = false } = {}) {
    if (!this.#reporter) return null;
    try {
      return await this.#reporter.publish({
        issueNumber: state.task.issueNumber,
        runId: state.runId,
        revision: state.task.revision,
        stage,
        summary,
        capsule: this.#capsule(state, snapshot),
        terminal,
        force
      });
    } catch (error) {
      state.statusError = { name: error.name, message: error.message, at: nowIso() };
      return null;
    }
  }

  async #respectTransientBackoff(key, state) {
    const retry = state.transientRetry;
    if (!retry?.notBefore) return;
    const notBefore = Date.parse(retry.notBefore);
    if (!Number.isFinite(notBefore)) throw new PolicyError('persisted transient retry deadline is malformed');
    const remaining = notBefore - this.#nowMs();
    if (remaining > 0) await this.#sleep(remaining);
    if (state.transientRetry?.notBefore === retry.notBefore) {
      state.transientRetry = { ...state.transientRetry, notBefore: null, delayMs: 0 };
      await this.#save(key, state);
    }
  }

  #scheduleTransientRetry(state, result) {
    const attempts = (state.transientRetry?.attempts ?? 0) + 1;
    const turnLimit = state.turnLimit ?? this.#maxTurns;
    if (state.turn >= turnLimit) {
      state.transientRetry = {
        classification: result.failureClassification ?? 'TRANSIENT', kind: result.retryKind ?? 'tool-availability', attempts,
        delayMs: 0, notBefore: null, exhausted: true, lastAt: new Date(this.#nowMs()).toISOString()
      };
      return null;
    }
    const delayMs = transientRetryDelay(attempts);
    const notBefore = new Date(this.#nowMs() + delayMs).toISOString();
    state.transientRetry = {
      classification: result.failureClassification ?? 'TRANSIENT', kind: result.retryKind ?? 'tool-availability', attempts,
      delayMs, notBefore, exhausted: false, lastAt: new Date(this.#nowMs()).toISOString()
    };
    return { attempts, delayMs, notBefore };
  }

  async #recordCandidateRejection(key, state, workspace, error) {
    const snapshot = await this.#workspace.snapshot(workspace);
    const summary = `PATCH-POLLER candidate validation rejected the proposal: ${error.message}`;
    state.stage = 'running';
    state.finalSnapshot = null;
    state.prior.changedFiles = snapshot.changedFiles;
    state.prior.git = { branch: snapshot.branch, baseSha: snapshot.baseSha, headSha: snapshot.headSha, dirty: snapshot.dirty };
    state.prior.blockers = [summary];
    state.prior.nextStep = 'Repair the candidate validation issues in the working tree, re-run relevant read-only checks, and report complete only when correct. Do not stage or commit; PATCH-POLLER owns Git administrative state.';
    state.prior.progress.push(summary);
    await this.#save(key, state);
    await this.#publish(state, 'REPAIRING', summary, snapshot, { force: true });
    return null;
  }

  async #evaluateHardGate(key, state, workspace) {
    if (!this.#decisionGate) return { allowed: true, snapshot: await this.#workspace.validate(workspace) };
    let snapshot;
    try { snapshot = await this.#workspace.validate(workspace); }
    catch (error) {
      if (state.task.envelope.controllerPlan) throw new PolicyError(`deterministic controller-plan candidate failed validation before hard gate: ${error.message}`, { cause: error });
      return { allowed: false, candidateRejected: true, result: await this.#recordCandidateRejection(key, state, workspace, new CandidateValidationError(error.message, { cause: error })) };
    }
    const gate = await this.#decisionGate.evaluate({ state, task: state.task, workspace, snapshot });
    await this.#save(key, state);
    if (gate.allowed) {
      if (gate.checkpoint?.decision && !state.prior.decisions.some((entry) => entry.source === 'trusted-decision' && entry.checkpointId === gate.checkpoint.checkpointId && entry.commentId === gate.checkpoint.decision.commentId)) {
        state.prior.decisions.push({
          source: 'trusted-decision',
          checkpointId: gate.checkpoint.checkpointId,
          decisionClass: gate.checkpoint.decisionClass,
          bindingMode: gate.checkpoint.bindingMode,
          subjectDigest: gate.checkpoint.subjectDigest,
          action: gate.checkpoint.decision.action,
          actorId: gate.checkpoint.decision.actorId,
          commentId: gate.checkpoint.decision.commentId,
          contentSha256: gate.checkpoint.decision.contentSha256,
          recordedAt: nowIso(),
        });
        await this.#save(key, state);
      }
      return { allowed: true, snapshot, gate };
    }

    if (gate.outcome === 'rejected' || gate.outcome === 'redirected') {
      state.stage = 'waiting-feedback';
      const action = gate.outcome === 'redirected' ? 'redirected' : 'rejected';
      const instruction = gate.checkpoint?.decision?.instructions ?? null;
      const summary = `Sensitive candidate ${action} at checkpoint ${gate.checkpoint.checkpointId}; sealing remains prohibited.`;
      state.prior.blockers = [summary];
      state.prior.nextStep = instruction;
      await this.#save(key, state);
      await this.#publish(state, 'DECISION_REQUIRED', summary, snapshot, { force: true });
      return { allowed: false, waiting: true, status: 'waiting-feedback', snapshot, gate };
    }

    state.stage = 'waiting-decision';
    const summary = `Hard gate ${gate.checkpoint.decisionClass} is pending for exact candidate digest ${gate.checkpoint.subjectDigest}; safe work is exhausted at the sealing frontier.`;
    state.prior.blockers = [summary];
    state.prior.nextStep = null;
    await this.#save(key, state);
    await this.#publish(state, 'HARD_GATE_PENDING', summary, snapshot, { force: true });
    return { allowed: false, waiting: true, status: 'waiting-decision', snapshot, gate };
  }

  async #finalize(key, state, workspace) {
    let finalSnapshot = state.finalSnapshot;
    if (state.stage !== 'publishing' || !finalSnapshot) {
      state.stage = 'verifying';
      await this.#save(key, state);

      const gated = await this.#evaluateHardGate(key, state, workspace);
      if (!gated.allowed) {
        if (gated.candidateRejected) return gated.result;
        return {
          runId: state.runId,
          issueNumber: state.task.issueNumber,
          status: gated.status ?? state.stage,
          waiting: true,
          branch: workspace.branch,
          headSha: gated.snapshot?.headSha ?? null,
          checkpoint: gated.gate?.checkpoint ?? null,
        };
      }

      try {
        finalSnapshot = await this.#workspace.sealCandidate(workspace, { issueNumber: state.task.issueNumber, revision: state.task.revision });
      } catch (error) {
        if (error instanceof CandidateValidationError) {
          if (state.task.envelope.controllerPlan) throw new PolicyError(`deterministic controller-plan candidate failed sealing: ${error.message}`, { cause: error });
          return this.#recordCandidateRejection(key, state, workspace, error);
        }
        throw error;
      }
      state.finalSnapshot = finalSnapshot;
      state.prior.changedFiles = finalSnapshot.changedFiles;
      state.prior.git = { branch: finalSnapshot.branch, baseSha: finalSnapshot.baseSha, headSha: finalSnapshot.headSha, dirty: finalSnapshot.dirty };
      state.prior.blockers = [];
      state.prior.nextStep = null;
      await this.#save(key, state);
    }

    const noProjectDiff = finalSnapshot.headSha === finalSnapshot.baseSha && finalSnapshot.changedFiles.length === 0;
    if (this.#autoPush && state.publication?.published !== true && !state.publication?.skipped) {
      if (noProjectDiff && !this.#forceNoOpPublication) {
        state.publication = { published: false, skipped: true, reason: 'no-project-diff', headSha: finalSnapshot.headSha, recordedAt: nowIso() };
        await this.#save(key, state);
      } else {
        state.stage = 'publishing';
        await this.#save(key, state);
        const publication = await this.#workspace.publishTaskBranch(workspace);
        state.publication = { published: true, ...publication, publishedAt: nowIso() };
        await this.#save(key, state);
      }
    }

    state.stage = 'completed';
    await this.#save(key, state);
    let summary;
    if (state.publication?.skipped) summary = `Completed and verified ${finalSnapshot.headSha}; publication skipped because there is no project diff.`;
    else if (this.#autoPush) summary = `Completed, sealed candidate ${finalSnapshot.headSha}, and published task branch ${workspace.branch}.`;
    else summary = `Completed and sealed candidate ${finalSnapshot.headSha} on local task branch ${workspace.branch}; automatic push is disabled.`;
    await this.#publish(state, 'COMPLETED', summary, finalSnapshot, { terminal: true, force: true });
    return {
      runId: state.runId, issueNumber: state.task.issueNumber, status: 'completed', branch: workspace.branch,
      headSha: finalSnapshot.headSha, changedFiles: finalSnapshot.changedFiles,
      published: state.publication?.published === true, publicationSkipped: state.publication?.skipped === true,
      publicationReason: state.publication?.reason ?? null
    };
  }

  async resumePending() {
    const entries = await this.#store.entries(`run.${this.#queueRepository}#`);
    const pending = entries.map(([, value]) => value).filter((state) => state?.task && !TERMINAL.has(state.stage)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (pending.length === 0) return null;
    return this.executeTask(pending[0].task);
  }

  async executeTask(task) {
    const key = this.#key(task);
    let state = await this.#store.get(key);
    if (state && TERMINAL.has(state.stage)) {
      return {
        runId: state.runId, issueNumber: task.issueNumber, status: state.stage, skipped: true,
        branch: state.workspace?.branch ?? null, headSha: state.finalSnapshot?.headSha ?? null,
        published: state.publication?.published === true, publicationSkipped: state.publication?.skipped === true,
        publicationReason: state.publication?.reason ?? null
      };
    }

    if (!state) {
      const siblings = await this.#store.entries(`run.${this.#queueRepository}#${task.issueNumber}.`);
      const activeSibling = siblings.map(([, value]) => value).find((candidate) => candidate?.task?.revision !== task.revision && !TERMINAL.has(candidate?.stage));
      if (activeSibling) {
        return { runId: activeSibling.runId, issueNumber: task.issueNumber, status: 'deferred-active-revision', deferred: true, activeRevision: activeSibling.task.revision, requestedRevision: task.revision };
      }
      state = {
        version: 1, runId: runIdForTask(task), task: structuredClone(task), stage: 'preparing', turn: 0, turnLimit: this.#maxTurns, createdAt: nowIso(),
        prior: { summary: task.envelope.context?.summary ?? null, decisions: [], progress: [], changedFiles: [], tests: [], git: null, blockers: [], nextStep: null, outputTail: null, receipt: null, liveness: null, toolInventory: null },
        lastFeedbackCommentId: 0, lastDecisionCommentId: 0, checkpoints: [], publication: { published: false }, transientRetry: null
      };
      await this.#save(key, state);
    } else if (!Number.isInteger(state.turnLimit) || state.turnLimit < state.turn) {
      state.turnLimit = Math.max(this.#maxTurns, state.turn);
      await this.#save(key, state);
    }
    state.prior.receipt ??= null;
    state.prior.liveness ??= null;
    state.checkpoints ??= [];
    state.lastDecisionCommentId ??= 0;

    try {
      if (state.stage === 'waiting-feedback') {
        if (!this.#feedback) return { runId: state.runId, issueNumber: task.issueNumber, status: state.stage, waiting: true };
        const polled = await this.#feedback.pollWaitingRun({ issueNumber: task.issueNumber, runId: state.runId, taskRevision: task.revision, afterCommentId: state.lastFeedbackCommentId ?? 0 });
        state.lastFeedbackCommentId = polled.highestCommentId ?? state.lastFeedbackCommentId ?? 0;
        if (!polled.feedback) { await this.#save(key, state); return { runId: state.runId, issueNumber: task.issueNumber, status: state.stage, waiting: true }; }
        if (polled.feedback.action === 'cancel') {
          state.stage = 'cancelled';
          state.prior.decisions.push({ source: 'trusted-feedback', action: 'cancel', actorId: polled.feedback.actorId, commentId: polled.feedback.commentId, contentSha256: polled.feedback.contentSha256, note: polled.feedback.instructions ?? null });
          await this.#save(key, state);
          await this.#publish(state, 'CANCELLED', 'Run cancelled by trusted feedback.', null, { terminal: true, force: true });
          return { runId: state.runId, issueNumber: task.issueNumber, status: 'cancelled' };
        }
        state.prior.decisions.push({ source: 'trusted-feedback', action: 'continue', actorId: polled.feedback.actorId, commentId: polled.feedback.commentId, contentSha256: polled.feedback.contentSha256, instructions: polled.feedback.instructions });
        state.prior.blockers = [];
        if (state.turn >= state.turnLimit) state.turnLimit = state.turn + this.#maxTurns;
        state.transientRetry = null;
        state.stage = 'running';
        await this.#save(key, state);
      }

      await this.#respectTransientBackoff(key, state);
      const plan = task.envelope.controllerPlan ?? null;
      if (plan && !this.#controllerPlansEnabled) throw new PolicyError('controller plans are disabled by local policy');
      const profile = plan ? null : this.#selectProfile(task);
      const workspace = await this.#workspace.prepareRun(task, state.runId, {
        baseRef: state.workspace?.baseRef ?? null,
        baseSha: state.workspace?.baseSha ?? null,
        baselineChannel: state.workspace?.baselineChannel ?? plan?.baselineChannel ?? null
      });
      state.workspace = workspace;
      state.prior.receipt ??= {
        inputSha256: task.revision, controllerPlanSha256: plan ? controllerPlanDigest(plan) : null, taskRevision: task.revision,
        inputSequence: 1, handoffSha256: null, runId: state.runId, effectiveBaselineSha: workspace.baseSha
      };

      if (state.stage === 'preparing') {
        state.stage = plan ? 'controller-plan' : 'running';
        await this.#save(key, state);
        await this.#publish(state, 'STARTED', plan ? `Claimed task for deterministic controller plan on baseline ${workspace.baselineChannel ?? 'repository-default'}@${workspace.baseSha}.` : `Claimed task with local tool profile ${profile.name}.`, await this.#workspace.snapshot(workspace), { force: true });
      } else await this.#save(key, state);

      if (state.stage === 'verifying' || state.stage === 'publishing' || state.stage === 'waiting-decision') {
        const finalized = await this.#finalize(key, state, workspace);
        if (finalized) return finalized;
      }

      if (plan) {
        if (!this.#planExecutor) throw new PolicyError('controller plan executor is not configured');
        state.stage = 'controller-plan';
        state.turn = Math.max(1, state.turn);
        state.prior.liveness = { stage: 'controller-plan', startedAt: state.controllerPlan?.startedAt ?? nowIso(), lastActivityAt: nowIso(), attempt: 1 };
        await this.#save(key, state);
        const execution = await this.#planExecutor.execute({
          plan, state, workspace, persist: () => this.#save(key, state),
          onLiveness: (activity) => { state.prior.liveness = { stage: 'deterministic-operation', operationId: activity.operationId, operation: activity.operation, lastActivityAt: activity.at, attempt: 1, sandboxProvider: activity.sandboxProvider ?? null }; }
        });
        state.prior.changedFiles = execution.snapshot.changedFiles;
        state.prior.git = { branch: execution.snapshot.branch, baseSha: execution.snapshot.baseSha, headSha: execution.snapshot.headSha, dirty: execution.snapshot.dirty };
        state.prior.tests = [...state.prior.tests, ...execution.tests].slice(-100);
        state.prior.progress.push(execution.summary);
        state.prior.nextStep = null;
        state.prior.blockers = [];
        state.prior.liveness = null;
        state.stage = 'verifying';
        await this.#save(key, state);
        const finalized = await this.#finalize(key, state, workspace);
        if (finalized) return finalized;
        throw new PolicyError('deterministic controller plan could not be finalized');
      }

      while (state.turn < state.turnLimit) {
        await this.#respectTransientBackoff(key, state);
        const before = await this.#workspace.validate(workspace);
        const context = this.#capsule(state, before);
        const nextTurn = state.turn + 1;
        state.stage = 'invoking';
        state.turn = nextTurn;
        await this.#save(key, state);

        const run = await this.#runner.run({ profile, projectDir: workspace.worktreeDir, runId: state.runId, turnId: `turn-${nextTurn}`, context });
        const snapshot = await this.#workspace.validate(workspace);
        const result = parseToolResult(run.result, { exitCode: run.exitCode, timedOut: run.timedOut, resultParseError: run.resultParseError, stdout: run.stdout, stderr: run.stderr });

        state.prior.changedFiles = snapshot.changedFiles;
        state.prior.git = { branch: snapshot.branch, baseSha: snapshot.baseSha, headSha: snapshot.headSha, dirty: snapshot.dirty };
        state.prior.outputTail = outputTail(run);
        state.prior.nextStep = result.nextStep;
        if (result.summary) state.prior.progress.push(result.summary);
        if (result.progress.length) state.prior.progress.push(...result.progress);
        if (result.tests.length) state.prior.tests = [...state.prior.tests, ...result.tests].slice(-100);
        if (result.checkpoint) state.prior.decisions.push({ source: 'proposal-checkpoint', ...result.checkpoint, recordedAt: nowIso() });

        if (result.status === 'continue') {
          state.stage = 'running';
          let summary = result.summary;
          if (result.retryable && result.failureClassification === 'TRANSIENT') {
            const scheduled = this.#scheduleTransientRetry(state, result);
            if (scheduled) {
              summary = `${result.summary} Transient retry ${scheduled.attempts} is scheduled after ${scheduled.delayMs} ms.`;
              state.prior.progress.push(`Transient retry ${scheduled.attempts} scheduled for ${scheduled.notBefore}.`);
            } else state.prior.progress.push(`Transient retry budget exhausted after ${state.transientRetry.attempts} attempts.`);
          } else state.transientRetry = null;
          await this.#save(key, state);
          await this.#publish(state, 'RUNNING', summary, snapshot);
          continue;
        }

        state.transientRetry = null;
        if (result.status === 'blocked') {
          state.stage = 'waiting-feedback';
          state.prior.blockers = [result.blocker ?? result.summary];
          await this.#save(key, state);
          await this.#publish(state, 'WAITING_FEEDBACK', result.summary, snapshot, { force: true });
          return { runId: state.runId, issueNumber: task.issueNumber, status: 'waiting-feedback', waiting: true, branch: workspace.branch, headSha: snapshot.headSha };
        }
        if (result.status === 'failed') {
          state.stage = 'failed';
          state.finalSnapshot = snapshot;
          state.error = { classification: result.blocker ?? 'code-or-tool-failure', message: result.summary };
          await this.#save(key, state);
          await this.#publish(state, 'FAILED', result.summary, snapshot, { terminal: true, force: true });
          return { runId: state.runId, issueNumber: task.issueNumber, status: 'failed', branch: workspace.branch, headSha: snapshot.headSha, error: state.error };
        }

        state.stage = 'verifying';
        await this.#save(key, state);
        const finalized = await this.#finalize(key, state, workspace);
        if (finalized) return finalized;
      }

      state.stage = 'waiting-feedback';
      const transientExhausted = state.transientRetry?.exhausted === true;
      const blocker = transientExhausted ? `Transient tool failure persisted through the bounded ${this.#maxTurns}-turn retry window; trusted continuation feedback is required.` : `Maximum turn budget window (${this.#maxTurns} turns) reached; trusted continuation feedback is required.`;
      state.prior.blockers = [blocker];
      await this.#save(key, state);
      await this.#publish(state, 'WAITING_FEEDBACK', blocker, state.finalSnapshot ?? null, { force: true });
      return { runId: state.runId, issueNumber: task.issueNumber, status: 'waiting-feedback', waiting: true, branch: state.workspace?.branch ?? null };
    } catch (error) {
      if (state.stage === 'verifying' || state.stage === 'publishing' || state.stage === 'waiting-decision') throw error;
      state.stage = 'failed';
      state.error = { classification: error.name, message: error.message, at: nowIso() };
      state.prior.liveness = null;
      await this.#save(key, state);
      await this.#publish(state, 'FAILED', `${error.name}: ${error.message}`, state.finalSnapshot ?? null, { terminal: true, force: true });
      return { runId: state.runId, issueNumber: task.issueNumber, status: 'failed', branch: state.workspace?.branch ?? null, error: state.error };
    }
  }
}
