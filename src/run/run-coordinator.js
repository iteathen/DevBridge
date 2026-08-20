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
import { controllerPlanDigest } from './controller-plan.js';
import { parseToolResult } from './result-envelope.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TRANSIENT_RETRY_BASE_MS = 5_000;
const TRANSIENT_RETRY_MAX_MS = 60_000;

function nowIso() {
  return new Date().toISOString();
}

function defaultSleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transientRetryDelay(attempt) {
  const exponent = Math.max(0, Math.min(20, attempt - 1));
  return Math.min(TRANSIENT_RETRY_MAX_MS, TRANSIENT_RETRY_BASE_MS * (2 ** exponent));
}

function outputTail(run) {
  const text = [run.stdout, run.stderr].filter(Boolean).join('\n');
  return text.length <= 8000 ? text : text.slice(-8000);
}

function gitProjection(snapshot) {
  if (!snapshot) return null;
  return {
    branch: snapshot.branch,
    baseSha: snapshot.baseSha,
    publicationBaseSha: snapshot.publicationBaseSha ?? snapshot.baseSha,
    headSha: snapshot.headSha,
    dirty: snapshot.dirty
  };
}

function feedbackProvenanceProjection(provenance) {
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

function feedbackProvenanceRecord(entry, { accepted = false, action = null } = {}) {
  return {
    source: accepted ? 'github-feedback' : 'github-feedback-rejected',
    accepted,
    action,
    commentId: entry.commentId ?? null,
    actorId: entry.actorId ?? null,
    reason: accepted ? null : (entry.reason ?? entry.provenance?.reason ?? 'provenance-rejected'),
    content: feedbackProvenanceProjection(entry.provenance),
    recordedAt: nowIso(),
  };
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
  #nowMs;
  #sleep;

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
    this.#nowMs = nowMs;
    this.#sleep = sleep;
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
    if (preferred && !Object.hasOwn(this.#tools, preferred)) {
      throw new PolicyError(`requested local coding tool is unavailable: ${preferred}`);
    }
    // A controller plan always wins. The configured default is only the fallback
    // for a task that arrived without an executable plan.
    const name = preferred || this.#defaultTool;
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
        git: snapshot ? gitProjection(snapshot) : state.prior.git,
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
        classification: result.failureClassification ?? 'TRANSIENT',
        kind: result.retryKind ?? 'tool-availability',
        attempts,
        delayMs: 0,
        notBefore: null,
        exhausted: true,
        lastAt: new Date(this.#nowMs()).toISOString()
      };
      return null;
    }
    const delayMs = transientRetryDelay(attempts);
    const notBefore = new Date(this.#nowMs() + delayMs).toISOString();
    state.transientRetry = {
      classification: result.failureClassification ?? 'TRANSIENT',
      kind: result.retryKind ?? 'tool-availability',
      attempts,
      delayMs,
      notBefore,
      exhausted: false,
      lastAt: new Date(this.#nowMs()).toISOString()
    };
    return { attempts, delayMs, notBefore };
  }

  async #recordCandidateRejection(key, state, workspace, error) {
    const snapshot = await this.#workspace.snapshot(workspace);
    const summary = `DevBridge candidate validation rejected the proposal: ${error.message}`;
    state.stage = 'running';
    state.finalSnapshot = null;
    state.prior.changedFiles = snapshot.changedFiles;
    state.prior.git = gitProjection(snapshot);
    state.prior.blockers = [summary];
    state.prior.nextStep = 'Repair the candidate validation issues in the working tree, re-run relevant read-only checks, and report complete only when correct. Do not stage or commit; DevBridge owns Git administrative state.';
    state.prior.progress.push(summary);
    await this.#save(key, state);
    await this.#publish(state, 'REPAIRING', summary, snapshot, { force: true });
    return null;
  }

  async #recordBaselineReverification(key, state, workspace, error) {
    const snapshot = await this.#workspace.snapshot(workspace);
    const reconciliation = error.reconciliation ?? {};
    const summary = `DevBridge rebased the sealed candidate from publication baseline ${reconciliation.fromBaseSha ?? 'unknown'} to ${reconciliation.toBaseSha ?? snapshot.publicationBaseSha}; prior verification is stale and must be repeated before publication.`;
    state.finalSnapshot = null;
    state.baselineReverifyRequired = true;
    state.baselineReconciliation ??= { history: [] };
    state.baselineReconciliation.history ??= [];
    state.baselineReconciliation.history.push({
      fromBaseSha: reconciliation.fromBaseSha ?? null,
      toBaseSha: reconciliation.toBaseSha ?? snapshot.publicationBaseSha,
      fromHeadSha: reconciliation.fromHeadSha ?? null,
      toHeadSha: reconciliation.toHeadSha ?? snapshot.headSha,
      recordedAt: nowIso()
    });
    state.baselineReconciliation.history = state.baselineReconciliation.history.slice(-20);
    state.prior.changedFiles = snapshot.changedFiles;
    state.prior.git = gitProjection(snapshot);
    state.prior.tests = [];
    state.prior.blockers = [];
    state.prior.nextStep = state.task.envelope.controllerPlan
      ? 'Re-run the deterministic controller plan and all of its assertions against the rebased publication baseline before finalization.'
      : 'The upstream baseline advanced and DevBridge rebased the sealed candidate. Re-run the relevant verification/tests against this rebased worktree before reporting complete. Do not stage or commit; DevBridge owns Git administrative state.';
    state.prior.progress.push(summary);
    state.stage = state.task.envelope.controllerPlan ? 'controller-plan' : 'running';
    await this.#save(key, state);
    await this.#publish(state, 'REVERIFYING', summary, snapshot, { force: true });
    return null;
  }

  async #consumeDeterministicBaselineReverification(key, state, workspace) {
    const turnLimit = state.turnLimit ?? this.#maxTurns;
    const currentAttempt = Math.max(1, state.turn);
    if (currentAttempt >= turnLimit) {
      state.stage = 'waiting-feedback';
      state.baselineReverifyRequired = false;
      const blocker = `Publication baseline kept advancing through the bounded ${turnLimit}-attempt deterministic reverification window; trusted continuation feedback is required.`;
      state.prior.blockers = [blocker];
      state.prior.nextStep = 'Inspect the publication-baseline drift and provide a trusted continuation decision. DevBridge will not replay the deterministic plan outside its bounded verification window.';
      await this.#save(key, state);
      await this.#publish(state, 'WAITING_FEEDBACK', blocker, await this.#workspace.snapshot(workspace), { force: true });
      return {
        runId: state.runId,
        issueNumber: state.task.issueNumber,
        status: 'waiting-feedback',
        waiting: true,
        branch: workspace.branch
      };
    }
    state.turn = currentAttempt + 1;
    state.baselineReverifyRequired = false;
    await this.#save(key, state);
    return null;
  }

  async #recordBaselineCheckpoint(key, state, workspace, error) {
    const snapshot = await this.#workspace.snapshot(workspace);
    const summary = `DevBridge cannot safely reconcile the publication baseline automatically: ${error.message}`;
    state.stage = 'waiting-feedback';
    state.finalSnapshot = null;
    state.baselineReverifyRequired = false;
    state.prior.changedFiles = snapshot.changedFiles;
    state.prior.git = gitProjection(snapshot);
    state.prior.blockers = [summary];
    state.prior.nextStep = 'Inspect the upstream baseline change and provide a trusted continuation decision. DevBridge will not rewrite upstream history or leave an unresolved rebase in the managed worktree.';
    state.prior.progress.push(summary);
    await this.#save(key, state);
    await this.#publish(state, 'WAITING_FEEDBACK', summary, snapshot, { force: true });
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
    const reasons = [];
    if (snapshot.dirty) reasons.push('the managed worktree became dirty');
    if (snapshot.headSha !== verifiedSnapshot.headSha) reasons.push(`HEAD moved from verified ${verifiedSnapshot.headSha} to ${snapshot.headSha}`);
    const observedPublicationBase = snapshot.publicationBaseSha ?? snapshot.baseSha;
    const verifiedPublicationBase = verifiedSnapshot.publicationBaseSha ?? verifiedSnapshot.baseSha;
    if (observedPublicationBase !== verifiedPublicationBase) {
      reasons.push(`publication baseline changed from ${verifiedPublicationBase} to ${observedPublicationBase}`);
    }
    const summary = `DevBridge observed local candidate identity drift after verification (${reasons.join('; ')}); prior verification is stale and must be repeated before publication.`;
    state.finalSnapshot = null;
    state.baselineReverifyRequired = false;
    state.prior.changedFiles = snapshot.changedFiles;
    state.prior.git = gitProjection(snapshot);
    state.prior.tests = [];
    state.prior.blockers = [];
    state.prior.nextStep = state.task.envelope.controllerPlan
      ? 'Re-run the deterministic controller plan and all of its assertions against the current managed candidate before publication.'
      : 'The managed candidate changed after verification. Re-run the relevant verification/tests against the current worktree before reporting complete. Do not stage or commit; DevBridge owns Git administrative state.';
    state.prior.progress.push(summary);

    if (state.task.envelope.controllerPlan) {
      const turnLimit = state.turnLimit ?? this.#maxTurns;
      const currentAttempt = Math.max(1, state.turn);
      if (currentAttempt >= turnLimit) {
        const blocker = `Local candidate identity kept drifting after verification through the bounded ${turnLimit}-attempt deterministic reverification window; trusted continuation feedback is required.`;
        state.stage = 'waiting-feedback';
        state.prior.blockers = [blocker];
        state.prior.nextStep = 'Inspect the post-verification local candidate drift and provide a trusted continuation decision. DevBridge will not replay the deterministic plan outside its bounded verification window.';
        await this.#save(key, state);
        await this.#publish(state, 'WAITING_FEEDBACK', blocker, snapshot, { force: true });
        return {
          runId: state.runId,
          issueNumber: state.task.issueNumber,
          status: 'waiting-feedback',
          waiting: true,
          branch: workspace.branch,
          headSha: snapshot.headSha
        };
      }
      state.turn = currentAttempt + 1;
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
      const observedPublicationBase = observed.publicationBaseSha ?? observed.baseSha;
      const verifiedPublicationBase = finalSnapshot.publicationBaseSha ?? finalSnapshot.baseSha;
      if (observed.dirty || observed.headSha !== finalSnapshot.headSha || observedPublicationBase !== verifiedPublicationBase) {
        return this.#recordLocalCandidateReverification(key, state, workspace, observed, finalSnapshot);
      }
      const checked = await this.#sealForFinalization(key, state, workspace);
      if (checked.handled) return checked.result;
      finalSnapshot = checked.snapshot;
      state.finalSnapshot = finalSnapshot;
      state.baselineReverifyRequired = false;
      state.prior.changedFiles = finalSnapshot.changedFiles;
      state.prior.git = gitProjection(finalSnapshot);
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
      state.prior.git = gitProjection(finalSnapshot);
      state.prior.blockers = [];
      state.prior.nextStep = null;
      await this.#save(key, state);
    }

    const publicationBaseSha = finalSnapshot.publicationBaseSha ?? finalSnapshot.baseSha;
    const noProjectDiff = finalSnapshot.headSha === publicationBaseSha && finalSnapshot.changedFiles.length === 0;
    if (this.#autoPush && state.publication?.published !== true && !state.publication?.skipped) {
      if (noProjectDiff && !this.#forceNoOpPublication) {
        state.publication = {
          published: false,
          skipped: true,
          reason: 'no-project-diff',
          headSha: finalSnapshot.headSha,
          publicationBaseSha,
          recordedAt: nowIso()
        };
        await this.#save(key, state);
      } else {
        state.stage = 'publishing';
        await this.#save(key, state);
        const publication = await this.#workspace.publishTaskBranch(workspace, {
          expectedHeadSha: finalSnapshot.headSha
        });
        state.publication = { published: true, ...publication, publicationBaseSha, publishedAt: nowIso() };
        await this.#save(key, state);
      }
    }

    state.stage = 'completed';
    await this.#save(key, state);
    let summary;
    if (state.publication?.skipped) {
      summary = `Completed and verified ${finalSnapshot.headSha}; publication skipped because there is no project diff.`;
    } else if (this.#autoPush) {
      summary = `Completed, sealed candidate ${finalSnapshot.headSha}, and published task branch ${workspace.branch}.`;
    } else {
      summary = `Completed and sealed candidate ${finalSnapshot.headSha} on local task branch ${workspace.branch}; automatic push is disabled.`;
    }
    await this.#publish(state, 'COMPLETED', summary, finalSnapshot, { terminal: true, force: true });
    return {
      runId: state.runId,
      issueNumber: state.task.issueNumber,
      status: 'completed',
      branch: workspace.branch,
      headSha: finalSnapshot.headSha,
      baseSha: finalSnapshot.baseSha,
      publicationBaseSha,
      changedFiles: finalSnapshot.changedFiles,
      published: state.publication?.published === true,
      publicationSkipped: state.publication?.skipped === true,
      publicationReason: state.publication?.reason ?? null
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
        const rejectedFeedback = Array.isArray(polled.rejected) ? polled.rejected : [];
        if (rejectedFeedback.length > 0) {
          state.prior.provenance.push(...rejectedFeedback.map((entry) => feedbackProvenanceRecord(entry)));
          state.prior.provenance = state.prior.provenance.slice(-100);
        }
        state.lastFeedbackCommentId = polled.highestCommentId ?? state.lastFeedbackCommentId ?? 0;
        if (!polled.feedback) {
          await this.#save(key, state);
          if (rejectedFeedback.length > 0) {
            const summary = polled.provenanceRetryRequired
              ? `Ignored ${rejectedFeedback.length} authority-shaped feedback comment(s) because exact edit provenance is temporarily unverifiable; the feedback cursor was not advanced and DevBridge will retry.`
              : `Ignored ${rejectedFeedback.length} authority-shaped feedback comment(s) because creator/editor provenance did not satisfy local trust policy.`;
            await this.#publish(state, 'WAITING_FEEDBACK', summary, null);
          }
          return {
            runId: state.runId,
            issueNumber: task.issueNumber,
            status: state.stage,
            waiting: true,
            rejectedFeedbackCount: rejectedFeedback.length
          };
        }
        state.prior.provenance.push(feedbackProvenanceRecord(polled.feedback, {
          accepted: true,
          action: polled.feedback.action,
        }));
        state.prior.provenance = state.prior.provenance.slice(-100);
        if (polled.feedback.action === 'cancel') {
          state.stage = 'cancelled';
          state.prior.decisions.push({
            source: 'trusted-feedback',
            action: 'cancel',
            actorId: polled.feedback.actorId,
            commentId: polled.feedback.commentId,
            contentSha256: polled.feedback.contentSha256,
            contentProvenance: feedbackProvenanceProjection(polled.feedback.provenance),
            note: polled.feedback.instructions ?? null
          });
          await this.#save(key, state);
          await this.#publish(state, 'CANCELLED', 'Run cancelled by trusted exact-content feedback.', null, {
            terminal: true,
            force: true
          });
          return { runId: state.runId, issueNumber: task.issueNumber, status: 'cancelled' };
        }
        state.prior.decisions.push({
          source: 'trusted-feedback',
          action: 'continue',
          actorId: polled.feedback.actorId,
          commentId: polled.feedback.commentId,
          contentSha256: polled.feedback.contentSha256,
          contentProvenance: feedbackProvenanceProjection(polled.feedback.provenance),
          instructions: polled.feedback.instructions
        });
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
        state.prior.git = gitProjection(execution.snapshot);
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
        state.prior.git = gitProjection(snapshot);
        state.prior.outputTail = outputTail(run);
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
