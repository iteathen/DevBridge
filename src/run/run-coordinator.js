import path from 'node:path';
import { buildContextCapsule } from '../context/context-capsule.js';
import { PolicyError } from '../errors.js';
import { validateToolProfile } from '../runtime/cli-profile.js';
import { parseToolResult } from './result-envelope.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
function nowIso() { return new Date().toISOString(); }
function outputTail(run) { const text = [run.stdout, run.stderr].filter(Boolean).join('\n'); return text.length <= 8000 ? text : text.slice(-8000); }
export function runIdForTask(task) { return `pp-${task.issueNumber}-${task.revision.slice(0, 16)}`; }

export class RunCoordinator {
  #store; #workspace; #runner; #reporter; #feedback; #queueRepository; #tools; #defaultTool; #maxTurns; #allowUncontainedTools; #autoPush;
  constructor({ stateStore, workspaceManager, processRunner, statusReporter = null, feedbackSource = null, queueRepository, tools, defaultTool = null, maxTurns = 8, allowUncontainedTools = false, autoPushTaskBranches = false }) {
    this.#store = stateStore; this.#workspace = workspaceManager; this.#runner = processRunner; this.#reporter = statusReporter; this.#feedback = feedbackSource; this.#queueRepository = queueRepository; this.#tools = tools; this.#defaultTool = defaultTool; this.#maxTurns = maxTurns; this.#allowUncontainedTools = allowUncontainedTools; this.#autoPush = autoPushTaskBranches;
  }

  #key(task) { return `run.${this.#queueRepository}#${task.issueNumber}.${task.revision}`; }
  async #save(key, state) { state.updatedAt = nowIso(); await this.#store.set(key, state); }
  #selectProfile(task) {
    const preferred = task.envelope.preferredTool;
    const name = preferred && Object.hasOwn(this.#tools, preferred) ? preferred : this.#defaultTool;
    if (!name || !Object.hasOwn(this.#tools, name)) throw new PolicyError(`no locally configured coding tool is available for task ${task.issueNumber}`);
    return validateToolProfile(name, this.#tools[name], { allowUncontainedTools: this.#allowUncontainedTools });
  }
  #capsule(state, snapshot = null) {
    return buildContextCapsule({ task: state.task, sequence: Math.max(1, state.turn + 1), prior: state.prior, runtime: { changedFiles: snapshot?.changedFiles ?? state.prior.changedFiles, tests: state.prior.tests, git: snapshot ? { branch: snapshot.branch, baseSha: snapshot.baseSha, headSha: snapshot.headSha, dirty: snapshot.dirty } : state.prior.git, blockers: state.prior.blockers, nextStep: state.prior.nextStep, outputTail: state.prior.outputTail } });
  }
  async #publish(state, stage, summary, snapshot = null, { terminal = false, force = false } = {}) {
    if (!this.#reporter) return null;
    try { return await this.#reporter.publish({ issueNumber: state.task.issueNumber, runId: state.runId, revision: state.task.revision, stage, summary, capsule: this.#capsule(state, snapshot), terminal, force }); }
    catch (error) { state.statusError = { name: error.name, message: error.message, at: nowIso() }; return null; }
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
    if (state && TERMINAL.has(state.stage)) return { runId: state.runId, issueNumber: task.issueNumber, status: state.stage, skipped: true, branch: state.workspace?.branch ?? null, headSha: state.finalSnapshot?.headSha ?? null, published: state.publication?.published === true };
    if (!state) {
      state = { version: 1, runId: runIdForTask(task), task: structuredClone(task), stage: 'preparing', turn: 0, createdAt: nowIso(), prior: { summary: task.envelope.context?.summary ?? null, decisions: [], progress: [], changedFiles: [], tests: [], git: null, blockers: [], nextStep: null, outputTail: null }, lastFeedbackCommentId: 0, publication: { published: false } };
      await this.#save(key, state);
    }

    try {
      if (state.stage === 'waiting-feedback') {
        if (!this.#feedback) return { runId: state.runId, issueNumber: task.issueNumber, status: state.stage, waiting: true };
        const polled = await this.#feedback.pollWaitingRun({ issueNumber: task.issueNumber, runId: state.runId, taskRevision: task.revision, afterCommentId: state.lastFeedbackCommentId ?? 0 });
        state.lastFeedbackCommentId = polled.highestCommentId ?? state.lastFeedbackCommentId ?? 0;
        if (!polled.feedback) { await this.#save(key, state); return { runId: state.runId, issueNumber: task.issueNumber, status: state.stage, waiting: true }; }
        if (polled.feedback.action === 'cancel') {
          state.stage = 'cancelled'; state.prior.decisions.push({ source: 'trusted-feedback', action: 'cancel', actorId: polled.feedback.actorId, commentId: polled.feedback.commentId, note: polled.feedback.instructions ?? null });
          await this.#save(key, state); await this.#publish(state, 'CANCELLED', 'Run cancelled by trusted feedback.', null, { terminal: true, force: true });
          return { runId: state.runId, issueNumber: task.issueNumber, status: 'cancelled' };
        }
        state.prior.decisions.push({ source: 'trusted-feedback', action: 'continue', actorId: polled.feedback.actorId, commentId: polled.feedback.commentId, instructions: polled.feedback.instructions });
        state.prior.blockers = [];
        state.stage = 'running';
        await this.#save(key, state);
      }

      const profile = this.#selectProfile(task);
      const workspace = await this.#workspace.prepareRun(task, state.runId);
      state.workspace = workspace;
      if (state.stage === 'preparing') { state.stage = 'running'; await this.#save(key, state); await this.#publish(state, 'STARTED', `Claimed task with local tool profile ${profile.name}.`, await this.#workspace.snapshot(workspace), { force: true }); }

      while (state.turn < this.#maxTurns) {
        const before = await this.#workspace.validate(workspace);
        const context = this.#capsule(state, before);
        const nextTurn = state.turn + 1;
        state.stage = 'invoking'; state.turn = nextTurn;
        await this.#save(key, state);
        const run = await this.#runner.run({ profile, projectDir: workspace.worktreeDir, runDir: path.join(workspace.worktreeDir, '.patch-poller', state.runId, `turn-${nextTurn}`), runId: state.runId, context });
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
          state.stage = 'running'; await this.#save(key, state); await this.#publish(state, 'RUNNING', result.summary, snapshot); continue;
        }
        if (result.status === 'blocked') {
          state.stage = 'waiting-feedback'; state.prior.blockers = [result.blocker ?? result.summary]; await this.#save(key, state); await this.#publish(state, 'WAITING_FEEDBACK', result.summary, snapshot, { force: true });
          return { runId: state.runId, issueNumber: task.issueNumber, status: 'waiting-feedback', waiting: true, branch: workspace.branch, headSha: snapshot.headSha };
        }
        if (result.status === 'failed') {
          state.stage = 'failed'; state.finalSnapshot = snapshot; state.error = { classification: result.blocker ?? 'code-or-tool-failure', message: result.summary }; await this.#save(key, state); await this.#publish(state, 'FAILED', result.summary, snapshot, { terminal: true, force: true });
          return { runId: state.runId, issueNumber: task.issueNumber, status: 'failed', branch: workspace.branch, headSha: snapshot.headSha, error: state.error };
        }

        state.stage = 'verifying'; await this.#save(key, state);
        const finalSnapshot = await this.#workspace.validate(workspace);
        state.finalSnapshot = finalSnapshot;
        if (this.#autoPush) {
          state.stage = 'publishing'; await this.#save(key, state);
          const publication = await this.#workspace.publishTaskBranch(workspace);
          state.publication = { published: true, ...publication, publishedAt: nowIso() };
        }
        state.stage = 'completed'; await this.#save(key, state);
        await this.#publish(state, 'COMPLETED', this.#autoPush ? `Completed and published task branch ${workspace.branch}.` : `Completed locally on task branch ${workspace.branch}; automatic push is disabled.`, finalSnapshot, { terminal: true, force: true });
        return { runId: state.runId, issueNumber: task.issueNumber, status: 'completed', branch: workspace.branch, headSha: finalSnapshot.headSha, changedFiles: finalSnapshot.changedFiles, published: state.publication.published === true };
      }

      state.stage = 'waiting-feedback'; state.prior.blockers = [`Maximum turn budget (${this.#maxTurns}) reached.`]; await this.#save(key, state); await this.#publish(state, 'WAITING_FEEDBACK', `Maximum turn budget (${this.#maxTurns}) reached; trusted continuation feedback is required.`, state.finalSnapshot ?? null, { force: true });
      return { runId: state.runId, issueNumber: task.issueNumber, status: 'waiting-feedback', waiting: true, branch: state.workspace?.branch ?? null };
    } catch (error) {
      state.stage = 'failed'; state.error = { classification: error.name, message: error.message, at: nowIso() }; await this.#save(key, state); await this.#publish(state, 'FAILED', `${error.name}: ${error.message}`, state.finalSnapshot ?? null, { terminal: true, force: true });
      return { runId: state.runId, issueNumber: task.issueNumber, status: 'failed', branch: state.workspace?.branch ?? null, error: state.error };
    }
  }
}
