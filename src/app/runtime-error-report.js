import { buildContextCapsule } from '../context/context-capsule.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function messageFor(error) {
  const name = typeof error?.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error?.message === 'string' && error.message ? error.message : String(error ?? 'unknown runtime error');
  return `${name}: ${message}`.slice(0, 4000);
}

function capsuleFor(state, summary) {
  const prior = state.prior ?? {};
  const blockers = [...(prior.blockers ?? [])];
  blockers.push(`PATCH-POLLER runtime error: ${summary}`);
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

export async function reportActiveRunRuntimeError(runtime, error) {
  if (!runtime?.stateStore || !runtime?.statusReporter || !runtime?.config?.github?.queueRepository) {
    return { reported: false, reason: 'runtime-reporting-unavailable' };
  }

  const prefix = `run.${runtime.config.github.queueRepository}#`;
  const entries = await runtime.stateStore.entries(prefix);
  const pending = entries
    .map(([, value]) => value)
    .filter((state) => state?.task && !TERMINAL.has(state.stage))
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));

  if (pending.length === 0) return { reported: false, reason: 'no-active-run' };

  const state = pending[0];
  const summary = messageFor(error);
  const result = await runtime.statusReporter.publish({
    issueNumber: state.task.issueNumber,
    runId: state.runId,
    revision: state.task.revision,
    stage: 'RUNTIME_ERROR',
    summary,
    capsule: capsuleFor(state, summary),
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
