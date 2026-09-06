import { buildContextCapsule } from '../context/context-capsule.js';
import { runIdForTask } from '../run/run-coordinator.js';
import { captureFailureDiagnostics } from '../run/failure-diagnostics.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function messageFor(error) {
  const name = typeof error?.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error?.message === 'string' && error.message ? error.message : String(error ?? 'unknown runtime error');
  return `${name}: ${message}`.slice(0, 4000);
}

function capsuleFor(state, summary) {
  const prior = state.prior ?? {};
  const blockers = [...(prior.blockers ?? [])];
  blockers.push(`DevBridge runtime error: ${summary}`);
  return buildContextCapsule({
    task: state.task,
    sequence: Math.max(1, Number(state.turn ?? 0) + 1),
    prior,
    runtime: {
      changedFiles: prior.changedFiles ?? [],
      tests: prior.tests ?? [],
      git: prior.git ?? null,
      blockers: blockers.slice(-20),
      nextStep: prior.nextStep ?? null,
      outputTail: prior.outputTail ?? null,
    },
  });
}

export async function reportTaskRuntimeError(runtime, task, error) {
  if (!runtime?.stateStore || !runtime?.statusReporter || typeof runtime?.queueRepository !== 'string') {
    return { reported: false, reason: 'runtime-reporting-unavailable' };
  }

  if (!task || task.queueRepository !== runtime.queueRepository) return { reported: false, reason: 'task-correlation-unavailable' };
  const state = await runtime.stateStore.get(`run.${runtime.queueRepository}#${task.issueNumber}.${task.revision}`);
  if (!state?.task || state.runId !== runIdForTask(task) || state.task.revision !== task.revision
      || state.task.issueNumber !== task.issueNumber || state.task.queueRepository !== runtime.queueRepository) {
    return { reported: false, reason: 'task-correlation-unavailable' };
  }
  if (TERMINAL.has(state.stage)) return { reported: false, reason: 'run-terminal' };
  const summary = messageFor(error);
  const result = await runtime.statusReporter.publish({
    issueNumber: state.task.issueNumber,
    runId: state.runId,
    revision: state.task.revision,
    stage: 'RUNTIME_ERROR',
    summary,
    capsule: capsuleFor(state, summary),
    diagnostics: captureFailureDiagnostics({ stage: state.stage, attempt: state.turn, error, secretValues: runtime.githubContext?.secretValues ?? [] }),
    terminal: false,
    force: true,
  });

  return {
    reported: result?.published === true,
    issueNumber: state.task.issueNumber,
    runId: state.runId,
    commentId: result?.commentId ?? null,
    sequence: result?.sequence ?? null,
  };
}

// A collection/daemon error has no task subject. In particular, an unrelated
// polling or inventory error must never be assigned to the oldest pending run.
export async function reportActiveRunRuntimeError() {
  return { reported: false, reason: 'task-correlation-unavailable' };
}
