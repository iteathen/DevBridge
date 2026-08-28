import path from 'node:path';
import { buildContextCapsule } from '../context/context-capsule.js';
import {
  BaselineReconciliationError,
  BaselineReverificationRequiredError,
  CandidateValidationError,
  PolicyError,
  TaskLeaseLostError,
} from '../errors.js';
import { validateToolProfile } from '../runtime/cli-profile.js';
import { CandidateRecovery } from './run-coordinator/candidate-recovery.js';
import { FeedbackContinuation } from './run-coordinator/feedback-continuation.js';
import { FinalizationPolicy } from './run-coordinator/finalization-policy.js';
import {
  boundedOutput,
  projectCandidateIdentity,
  projectContentEvidence,
} from './run-coordinator/projections.js';
import { RetryWindow, RetryWindowError } from './run-coordinator/retry-window.js';
import { controllerPlanDigest } from './controller-plan.js';
import { parseToolResult } from './result-envelope.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function nowIso() {
  return new Date().toISOString();
}

function defaultSleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runIdForTask(task) {
  return `pp-${task.issueNumber}-${task.revision.slice(0, 16)}`;
}

export class RunCoordinator {
  #store;
  #workspace;
  #runner;
  #planExecutor;
  #reporter;
  #feedback;
  #queueRepository;
  #tools;
  #defaultTool;
  #maxTurns;
  #allowUncontainedTools;
  #controllerPlansEnabled;
  #modelAdaptersEnabled;
  #deterministicProfileNames;
  #autoPush;
  #forceNoOpPublication;
  #retryWindow;
  #feedbackContinuation;
  #candidateRecovery;
  #finalizationPolicy;

  constructor({
    stateStore,
    workspaceManager,
    processRunner,
    controllerPlanExecutor = null,
    statusReporter = null,
    feedbackSource = null,
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
    this.#retryWindow = new RetryWindow({ now: nowMs, wait: sleep });
    this.#feedbackContinuation = new FeedbackContinuation({
      recordKinds: {
        accepted: 'github-feedback',
        rejected: 'github-feedback-rejected',
        decision: 'trusted-feedback',
      },
      projectEvidence: projectContentEvidence,
      now: nowIso,
    });
    this.#candidateRecovery = new CandidateRecovery({ now: nowIso });
    this.#finalizationPolicy = new FinalizationPolicy();
  }

  #key(task) {
    return `run.${this.#queueRepository}#${task.issueNumber}.${task.revision}`;
  }

  async #save(key, state) {
    state.updatedAt = nowIso();
    await this.#store.set(key, state);
  }

  #selectProfile(task) {
    const preferred = task.envelope.preferredTool;
    const name = preferred && Object.hasOwn(this.#tools, preferred) ? preferred : this.#defaultTool;
    if (!this.#modelAdaptersEnabled && !this.#deterministicProfileNames.has(name)) {
      throw new PolicyError('coding-model adapters are disabled by local policy; submit a controller plan or explicitly enable a compatibility adapter');
    }
    if (!name || !Object.hasOwn(this.#tools, name)) {
      throw new PolicyError(`no locally configured coding tool is available for task ${task.issueNumber}`);
    }
    return validateToolProfile(name, this.#tools[name], {
      allowUncontainedTools: this.#allowUncontainedTools
    });
  }

  #capsule(state, snapshot = null) {
    return buildContextCapsule({
      task: state.task,
      sequence: Math.max(1, state.turn + 1),
      prior: state.prior,
      runtime: {
        changedFiles: snapshot?.changedFiles ?? state.prior.changedFiles,
        tests: state.prior.tests,
        git: snapshot ? projectCandidateIdentity(snapshot) : state.prior.git,
        blockers: state.prior.blockers,
        nextStep: state.prior.nextStep,
        outputTail: state.prior.outputTail,
        receipt: state.prior.receipt ?? null,
        liveness: state.prior.liveness ?? null
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
    try {
      if (!await this.#retryWindow.respect(retry)) return;
    } catch (error) {
      if (error instanceof RetryWindowError) throw new PolicyError(error.message, { cause: error });
      throw error;
    }
    if (state.transientRetry?.notBefore === retry.notBefore) {
      state.transientRetry = { ...state.transientRetry, notBefore: null, delayMs: 0 };
      await this.#save(key, state);
    }
  }

  #scheduleTransientRetry(state, result) {
    const turnLimit = state.turnLimit ?? this.#maxTurns;
    const next = this.#retryWindow.schedule({
      current: state.transientRetry,
      completed: state.turn,
      limit: turnLimit,
      classification: result.failureClassification,
      kind: result.retryKind,
    });
    state.transientRetry = next.record;
    return next.scheduled;
  }

  async #recordCandidateRejection(key, state, workspace, error) {
    const snapshot = await this.#workspace.snapshot(workspace);
    const summary = `DevBridge candidate validation rejected the proposal: ${error.message}`;
    const recovery = this.#candidateRecovery.rejection({
      summary,
      nextStep: 'Repair the candidate validation issues in the working tree, re-run relevant read-only checks, and report complete only when correct. Do not stage or commit; DevBridge owns Git administrative state.',
    });
    state.stage = 'running';
    state.finalSnapshot = null;
    state.prior.changedFiles = snapshot.changedFiles;
    state.prior.git = projectCandidateIdentity(snapshot);
    state.prior.blockers = recovery.blockers;
    state.prior.nextStep = recovery.nextStep;
    state.prior.progress.push(recovery.summary);
    await this.#save(key, state);
    await this.#publish(state, 'REPAIRING', recovery.summary, snapshot, { force: true });
    return null;
  }

  async #recordBaselineReverification(key, state, workspace, error) {
    const snapshot = await this.#workspace.snapshot(workspace);
    const reconciliation = error.reconciliation ?? {};
    const planned = Boolean(state.task.envelope.controllerPlan);
    const summary = `DevBridge rebased the sealed candidate from publication baseline ${reconciliation.fromBaseSha ?? 'unknown'} to ${reconciliation.toBaseSha ?? snapshot.publicationBaseSha}; prior verification is stale and must be repeated before publication.`;
    const recovery = this.#candidateRecovery.baselineReverification({
      reconciliation,
      snapshot,
      history: state.baselineReconciliation?.history,
      summary,
      nextStep: planned
        ? 'Re-run the deterministic controller plan and all of its assertions against the rebased publication baseline before finalization.'
        : 'The upstream baseline advanced and DevBridge rebased the sealed candidate. Re-run the relevant verification/tests against this rebased worktree before reporting complete. Do not stage or commit; DevBridge owns Git administrative state.',
    });
    state.finalSnapshot = null;
    state.baselineReverifyRequired = true;
    state.baselineReconciliation = {
      ...(state.baselineReconciliation ?? {}),
      history: recovery.history,
    };
    state.prior.changedFiles = snapshot.changedFiles;
    state.prior.git = projectCandidateIdentity(snapshot);
    state.prior.tests = [];
    state.prior.blockers = [];
    state.prior.nextStep = recovery.nextStep;
    state.prior.progress.push(recovery.summary);
    state.stage = state.task.envelope.controllerPlan ? 'controller-plan' : 'running';
    await this.#save(key, state);
    await this.#publish(state, 'REVERIFYING', recovery.summary, snapshot, { force: true });
    return null;
  }

  async #consumeDeterministicBaselineReverification(key, state, workspace) {
    const turnLimit = state.turnLimit ?? this.#maxTurns;
    const attempt = this.#candidateRecovery.boundedReverification({
      completed: state.turn,
      limit: turnLimit,
      exhausted: {
        blocker: `Publication baseline kept advancing through the bounded ${turnLimit}-attempt deterministic reverification window; trusted continuation feedback is required.`,
        nextStep: 'Inspect the publication-baseline drift and provide a trusted continuation decision. DevBridge will not replay the deterministic plan outside its bounded verification window.',
      },
    });
    if (attempt.exhausted) {
      state.stage = 'waiting-feedback';
      state.baselineReverifyRequired = false;
      state.prior.blockers = [attempt.blocker];
      state.prior.nextStep = attempt.nextStep;
      await this.#save(key, state);
      await this.#publish(state, 'WAITING_FEEDBACK', attempt.blocker, await this.#workspace.snapshot(workspace), { force: true });
      return {
        runId: state.runId,
        issueNumber: state.task.issueNumber,
        status: 'waiting-feedback',
        waiting: true,
        branch: workspace.branch
      };
    }
    state.turn = attempt.next;
    state.baselineReverifyRequired = false;
    await this.#save(key, state);
    return null;
  }

  async #recordBaselineCheckpoint(key, state, workspace, error) {
    const snapshot = await this.#workspace.snapshot(workspace);
    const summary = `DevBridge cannot safely reconcile the publication baseline automatically: ${error.message}`;
    const recovery = this.#candidateRecovery.baselineCheckpoint({
      summary,
      nextStep: 'Inspect the upstream baseline change and provide a trusted continuation decision. DevBridge will not rewrite upstream history or leave an unresolved rebase in the managed worktree.',
    });
    state.stage = 'waiting-feedback';
    state.finalSnapshot = null;
    state.baselineReverifyRequired = false;
    state.prior.changedFiles = snapshot.changedFiles;
    state.prior.git = projectCandidateIdentity(snapshot);
    state.prior.blockers = recovery.blockers;
    state.prior.nextStep = recovery.nextStep;
    state.prior.progress.push(recovery.summary);
    await this.#save(key, state);
    await this.#publish(state, 'WAITING_FEEDBACK', recovery.summary, snapshot, { force: true });
    return {
      runId: state.runId,
      issueNumber: state.task.issueNumber,
      status: 'waiting-feedback',
      waiting: true,
      branch: workspace.branch,
      headSha: snapshot.headSha
    };
  }

  async #recordLocalCandidateReverification(key, state, workspace, snapshot, verifiedSnapshot) {
    const planned = Boolean(state.task.envelope.controllerPlan);
    const recovery = this.#candidateRecovery.localReverification({
      observed: snapshot,
      verified: verifiedSnapshot,
      completed: state.turn,
      limit: state.turnLimit ?? this.#maxTurns,
      exhausted: {
        blocker: `Local candidate identity kept drifting after verification through the bounded ${state.turnLimit ?? this.#maxTurns}-attempt deterministic reverification window; trusted continuation feedback is required.`,
        nextStep: 'Inspect the post-verification local candidate drift and provide a trusted continuation decision. DevBridge will not replay the deterministic plan outside its bounded verification window.',
      },
    });
    const summary = `DevBridge observed local candidate identity drift after verification (${recovery.reasons.join('; ')}); prior verification is stale and must be repeated before publication.`;
    const nextStep = planned
      ? 'Re-run the deterministic controller plan and all of its assertions against the current managed candidate before publication.'
      : 'The managed candidate changed after verification. Re-run the relevant verification/tests against the current worktree before reporting complete. Do not stage or commit; DevBridge owns Git administrative state.';
    state.finalSnapshot = null;
    state.baselineReverifyRequired = false;
    state.prior.changedFiles = snapshot.changedFiles;
    state.prior.git = projectCandidateIdentity(snapshot);
    state.prior.tests = [];
    state.prior.blockers = [];
    state.prior.nextStep = nextStep;
    state.prior.progress.push(summary);

    if (planned) {
      if (recovery.attempt.exhausted) {
        state.stage = 'waiting-feedback';
        state.prior.blockers = [recovery.attempt.blocker];
        state.prior.nextStep = recovery.attempt.nextStep;
        await this.#save(key, state);
        await this.#publish(state, 'WAITING_FEEDBACK', recovery.attempt.blocker, snapshot, { force: true });
        return {
          runId: state.runId,
          issueNumber: state.task.issueNumber,
          status: 'waiting-feedback',
          waiting: true,
          branch: workspace.branch,
          headSha: snapshot.headSha
        };
      }
      state.turn = recovery.attempt.next;
      state.stage = 'controller-plan';
    } else {
      state.stage = 'running';
    }

    await this.#save(key, state);
    await this.#publish(state, 'REVERIFYING', summary, snapshot, { force: true });
    return null;
  }

  async #sealForFinalization(key, state, workspace) {
    try {
      return {
        handled: false,
        snapshot: await this.#workspace.sealCandidate(workspace, {
          issueNumber: state.task.issueNumber,
          revision: state.task.revision
        })
      };
    } catch (error) {
      if (error instanceof BaselineReverificationRequiredError) {
        return { handled: true, result: await this.#recordBaselineReverification(key, state, workspace, error) };
      }
      if (error instanceof BaselineReconciliationError) {
        if (error.kind === 'upstream-history-rewrite' || state.task.envelope.controllerPlan) {
          return { handled: true, result: await this.#recordBaselineCheckpoint(key, state, workspace, error) };
        }
        return { handled: true, result: await this.#recordCandidateRejection(key, state, workspace, error) };
      }
      if (error instanceof CandidateValidationError) {
        if (state.task.envelope.controllerPlan) {
          throw new PolicyError(`deterministic controller-plan candidate failed sealing: ${error.message}`, { cause: error });
        }
        return { handled: true, result: await this.#recordCandidateRejection(key, state, workspace, error) };
      }
      throw error;
    }
  }

  async #finalize(key, state, workspace) {
    let finalSnapshot = state.finalSnapshot;

    if (state.stage === 'publishing' && finalSnapshot) {
      const observed = await this.#workspace.snapshot(workspace);
      if (this.#finalizationPolicy.identityChanged(observed, finalSnapshot)) {
        return this.#recordLocalCandidateReverification(key, state, workspace, observed, finalSnapshot);
      }
      const checked = await this.#sealForFinalization(key, state, workspace);
      if (checked.handled) return checked.result;
      finalSnapshot = checked.snapshot;
      state.finalSnapshot = finalSnapshot;
      state.baselineReverifyRequired = false;
      state.prior.changedFiles = finalSnapshot.changedFiles;
      state.prior.git = projectCandidateIdentity(finalSnapshot);
      state.prior.blockers = [];
      state.prior.nextStep = null;
      await this.#save(key, state);
    } else {
      state.stage = 'verifying';
      await this.#save(key, state);
      const sealed = await this.#sealForFinalization(key, state, workspace);
      if (sealed.handled) return sealed.result;
      finalSnapshot = sealed.snapshot;
      state.finalSnapshot = finalSnapshot;
      state.baselineReverifyRequired = false;
      state.prior.changedFiles = finalSnapshot.changedFiles;
      state.prior.git = projectCandidateIdentity(finalSnapshot);
      state.prior.blockers = [];
      state.prior.nextStep = null;
      await this.#save(key, state);
    }

    const disposition = this.#finalizationPolicy.publication({
      snapshot: finalSnapshot,
      enabled: this.#autoPush,
      alreadyPublished: state.publication?.published === true,
      alreadySkipped: Boolean(state.publication?.skipped),
      forceEmpty: this.#forceNoOpPublication,
    });
    if (disposition.kind === 'skip') {
        state.publication = {
          published: false,
          skipped: true,
          reason: 'no-project-diff',
          headSha: finalSnapshot.headSha,
          publicationBaseSha: disposition.baseSha,
          recordedAt: nowIso()
        };
        await this.#save(key, state);
    } else if (disposition.kind === 'publish') {
        state.stage = 'publishing';
        await this.#save(key, state);
        const publication = await this.#workspace.publishTaskBranch(workspace, {
          expectedHeadSha: disposition.expectedHeadSha
        });
        state.publication = { published: true, ...publication, publicationBaseSha: disposition.baseSha, publishedAt: nowIso() };
        await this.#save(key, state);
    }

    state.stage = 'completed';
    await this.#save(key, state);
    const completion = this.#finalizationPolicy.completion({
      snapshot: finalSnapshot,
      branch: workspace.branch,
      automatic: this.#autoPush,
      publication: state.publication,
    });
    await this.#publish(state, 'COMPLETED', completion.summary, finalSnapshot, { terminal: true, force: true });
    return {
      runId: state.runId,
      issueNumber: state.task.issueNumber,
      status: 'completed',
      branch: workspace.branch,
      headSha: finalSnapshot.headSha,
      baseSha: finalSnapshot.baseSha,
      publicationBaseSha: completion.baseSha,
      changedFiles: completion.changedFiles,
      published: completion.published,
      publicationSkipped: completion.skipped,
      publicationReason: completion.reason
    };
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

  async executeTask(task) {
    const key = this.#key(task);
    let state = await this.#store.get(key);
    if (state && TERMINAL.has(state.stage)) {
      return {
        runId: state.runId,
        issueNumber: task.issueNumber,
        status: state.stage,
        skipped: true,
        branch: state.workspace?.branch ?? null,
        headSha: state.finalSnapshot?.headSha ?? null,
        published: state.publication?.published === true,
        publicationSkipped: state.publication?.skipped === true,
        publicationReason: state.publication?.reason ?? null
      };
    }

    if (!state) {
      const siblings = await this.#store.entries(`run.${this.#queueRepository}#${task.issueNumber}.`);
      const activeSibling = siblings
        .map(([, value]) => value)
        .find((candidate) => candidate?.task?.revision !== task.revision && !TERMINAL.has(candidate?.stage));
      if (activeSibling) {
        return {
          runId: activeSibling.runId,
          issueNumber: task.issueNumber,
          status: 'deferred-active-revision',
          deferred: true,
          activeRevision: activeSibling.task.revision,
          requestedRevision: task.revision
        };
      }

      state = {
        version: 1,
        runId: runIdForTask(task),
        task: structuredClone(task),
        stage: 'preparing',
        turn: 0,
        turnLimit: this.#maxTurns,
        createdAt: nowIso(),
        prior: {
          summary: task.envelope.context?.summary ?? null,
          decisions: [],
          provenance: [],
          progress: [],
          changedFiles: [],
          tests: [],
          git: null,
          blockers: [],
          nextStep: null,
          outputTail: null,
          receipt: null,
          liveness: null
        },
        lastFeedbackCommentId: 0,
        publication: { published: false },
        transientRetry: null
      };
      await this.#save(key, state);
    } else if (!Number.isInteger(state.turnLimit) || state.turnLimit < state.turn) {
      state.turnLimit = Math.max(this.#maxTurns, state.turn);
      await this.#save(key, state);
    }
    state.prior.receipt ??= null;
    state.prior.liveness ??= null;
    state.prior.provenance ??= [];

    try {
      if (state.stage === 'waiting-feedback') {
        if (!this.#feedback) {
          return { runId: state.runId, issueNumber: task.issueNumber, status: state.stage, waiting: true };
        }
        const polled = await this.#feedback.pollWaitingRun({
          issueNumber: task.issueNumber,
          runId: state.runId,
          taskRevision: task.revision,
          afterCommentId: state.lastFeedbackCommentId ?? 0
        });
        const feedback = this.#feedbackContinuation.interpret({
          poll: polled,
          provenance: state.prior.provenance,
          cursor: state.lastFeedbackCommentId,
          completed: state.turn,
          limit: state.turnLimit,
          extension: this.#maxTurns,
        });
        state.prior.provenance = feedback.provenance;
        state.lastFeedbackCommentId = feedback.cursor;
        if (feedback.kind === 'idle') {
          await this.#save(key, state);
          if (feedback.rejectedCount > 0) {
            const summary = feedback.retryRequired
              ? `Ignored ${feedback.rejectedCount} authority-shaped feedback comment(s) because exact edit provenance is temporarily unverifiable; the feedback cursor was not advanced and DevBridge will retry.`
              : `Ignored ${feedback.rejectedCount} authority-shaped feedback comment(s) because creator/editor provenance did not satisfy local trust policy.`;
            await this.#publish(state, 'WAITING_FEEDBACK', summary, null);
          }
          return {
            runId: state.runId,
            issueNumber: task.issueNumber,
            status: state.stage,
            waiting: true,
            rejectedFeedbackCount: feedback.rejectedCount
          };
        }
        state.prior.decisions.push(feedback.decision);
        if (feedback.kind === 'cancel') {
          state.stage = 'cancelled';
          await this.#save(key, state);
          await this.#publish(state, 'CANCELLED', 'Run cancelled by trusted exact-content feedback.', null, {
            terminal: true,
            force: true
          });
          return { runId: state.runId, issueNumber: task.issueNumber, status: 'cancelled' };
        }
        state.prior.blockers = [];
        state.turnLimit = feedback.limit;
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
        baselineChannel: state.workspace?.baselineChannel ?? plan?.baselineChannel ?? null,
        publicationBaseSha: state.workspace?.publicationBaseSha ?? null,
        taskBranchKnownRemoteHeads: state.workspace?.taskBranchKnownRemoteHeads ?? []
      });
      state.workspace = workspace;
      state.prior.receipt ??= {
        inputSha256: task.revision,
        controllerPlanSha256: plan ? controllerPlanDigest(plan) : null,
        taskRevision: task.revision,
        inputSequence: 1,
        handoffSha256: null,
        runId: state.runId,
        effectiveBaselineSha: workspace.baseSha
      };

      if (state.stage === 'preparing') {
        state.stage = plan ? 'controller-plan' : 'running';
        await this.#save(key, state);
        await this.#publish(
          state,
          'STARTED',
          plan
            ? `Claimed task for deterministic controller plan on baseline ${workspace.baselineChannel ?? 'repository-default'}@${workspace.baseSha}.`
            : `Claimed task with local tool profile ${profile.name}.`,
          await this.#workspace.snapshot(workspace),
          { force: true }
        );
      } else {
        await this.#save(key, state);
      }

      if (state.stage === 'verifying' || state.stage === 'publishing') {
        const finalized = await this.#finalize(key, state, workspace);
        if (finalized) return finalized;
        if (plan && state.stage === 'controller-plan' && state.baselineReverifyRequired) {
          const checkpoint = await this.#consumeDeterministicBaselineReverification(key, state, workspace);
          if (checkpoint) return checkpoint;
        }
      }

      if (plan) {
        if (!this.#planExecutor) throw new PolicyError('controller plan executor is not configured');
        state.stage = 'controller-plan';
        state.turn = Math.max(1, state.turn);
        state.baselineReverifyRequired = false;
        state.prior.liveness = {
          stage: 'controller-plan',
          startedAt: state.controllerPlan?.startedAt ?? nowIso(),
          lastActivityAt: nowIso(),
          attempt: state.turn
        };
        await this.#save(key, state);
        const execution = await this.#planExecutor.execute({
          plan,
          state,
          workspace,
          persist: () => this.#save(key, state),
          onLiveness: (activity) => {
            state.prior.liveness = {
              stage: 'deterministic-operation',
              operationId: activity.operationId,
              operation: activity.operation,
              lastActivityAt: activity.at,
              attempt: state.turn
            };
          }
        });
        state.prior.changedFiles = execution.snapshot.changedFiles;
        state.prior.git = projectCandidateIdentity(execution.snapshot);
        state.prior.tests = [...state.prior.tests, ...execution.tests].slice(-100);
        state.prior.progress.push(execution.summary);
        state.prior.nextStep = null;
        state.prior.blockers = [];
        state.prior.liveness = null;
        state.stage = 'verifying';
        await this.#save(key, state);
        const finalized = await this.#finalize(key, state, workspace);
        if (finalized) return finalized;
        if (state.stage === 'controller-plan' && state.baselineReverifyRequired) {
          const checkpoint = await this.#consumeDeterministicBaselineReverification(key, state, workspace);
          if (checkpoint) return checkpoint;
          return this.executeTask(task);
        }
        throw new PolicyError('deterministic controller plan could not be finalized');
      }

      while (state.turn < state.turnLimit) {
        await this.#respectTransientBackoff(key, state);
        const before = await this.#workspace.validate(workspace);
        const context = this.#capsule(state, before);
        const nextTurn = state.turn + 1;
        state.stage = 'invoking';
        state.turn = nextTurn;
        state.baselineReverifyRequired = false;
        await this.#save(key, state);

        const run = await this.#runner.run({
          profile,
          projectDir: workspace.worktreeDir,
          runDir: path.join(workspace.worktreeDir, '.devbridge', state.runId, `turn-${nextTurn}`),
          runId: state.runId,
          context
        });
        const snapshot = await this.#workspace.validate(workspace);
        const result = parseToolResult(run.result, {
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          resultParseError: run.resultParseError,
          stdout: run.stdout,
          stderr: run.stderr
        });

        state.prior.changedFiles = snapshot.changedFiles;
        state.prior.git = projectCandidateIdentity(snapshot);
        state.prior.outputTail = boundedOutput(run);
        state.prior.nextStep = result.nextStep;
        if (result.summary) state.prior.progress.push(result.summary);
        if (result.progress.length) state.prior.progress.push(...result.progress);
        if (result.tests.length) state.prior.tests = [...state.prior.tests, ...result.tests].slice(-100);
        if (result.checkpoint) {
          state.prior.decisions.push({
            source: 'proposal-checkpoint',
            ...result.checkpoint,
            recordedAt: nowIso()
          });
        }

        if (result.status === 'continue') {
          state.stage = 'running';
          let summary = result.summary;
          if (result.retryable && result.failureClassification === 'TRANSIENT') {
            const scheduled = this.#scheduleTransientRetry(state, result);
            if (scheduled) {
              summary = `${result.summary} Transient retry ${scheduled.attempts} is scheduled after ${scheduled.delayMs} ms.`;
              state.prior.progress.push(`Transient retry ${scheduled.attempts} scheduled for ${scheduled.notBefore}.`);
            } else {
              state.prior.progress.push(`Transient retry budget exhausted after ${state.transientRetry.attempts} attempts.`);
            }
          } else {
            state.transientRetry = null;
          }
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
          return {
            runId: state.runId,
            issueNumber: task.issueNumber,
            status: 'waiting-feedback',
            waiting: true,
            branch: workspace.branch,
            headSha: snapshot.headSha
          };
        }
        if (result.status === 'failed') {
          state.stage = 'failed';
          state.finalSnapshot = snapshot;
          state.error = {
            classification: result.blocker ?? 'code-or-tool-failure',
            message: result.summary
          };
          await this.#save(key, state);
          await this.#publish(state, 'FAILED', result.summary, snapshot, { terminal: true, force: true });
          return {
            runId: state.runId,
            issueNumber: task.issueNumber,
            status: 'failed',
            branch: workspace.branch,
            headSha: snapshot.headSha,
            error: state.error
          };
        }

        state.stage = 'verifying';
        await this.#save(key, state);
        const finalized = await this.#finalize(key, state, workspace);
        if (finalized) return finalized;
      }

      state.stage = 'waiting-feedback';
      const transientExhausted = state.transientRetry?.exhausted === true;
      const blocker = transientExhausted
        ? `Transient tool failure persisted through the bounded ${this.#maxTurns}-turn retry window; trusted continuation feedback is required.`
        : `Maximum turn budget window (${this.#maxTurns} turns) reached; trusted continuation feedback is required.`;
      state.prior.blockers = [blocker];
      await this.#save(key, state);
      await this.#publish(
        state,
        'WAITING_FEEDBACK',
        blocker,
        state.finalSnapshot ?? null,
        { force: true }
      );
      return {
        runId: state.runId,
        issueNumber: task.issueNumber,
        status: 'waiting-feedback',
        waiting: true,
        branch: state.workspace?.branch ?? null
      };
    } catch (error) {
      if (error instanceof TaskLeaseLostError) {
        if (state.stage === 'invoking') state.stage = 'running';
        state.prior.liveness = null;
        state.leaseFence = { classification: error.name, message: error.message, at: nowIso() };
        await this.#save(key, state);
        throw error;
      }
      if (state.stage === 'verifying' || state.stage === 'publishing') throw error;

      state.stage = 'failed';
      state.error = { classification: error.name, message: error.message, at: nowIso() };
      state.prior.liveness = null;
      await this.#save(key, state);
      await this.#publish(
        state,
        'FAILED',
        `${error.name}: ${error.message}`,
        state.finalSnapshot ?? null,
        { terminal: true, force: true }
      );
      return {
        runId: state.runId,
        issueNumber: task.issueNumber,
        status: 'failed',
        branch: state.workspace?.branch ?? null,
        error: state.error
      };
    }
  }
}
