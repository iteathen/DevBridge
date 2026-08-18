import { buildContextCapsule } from '../context/context-capsule.js';

function boundedLiveness(state, activity) {
  const operationRecord = state.controllerPlan?.operations?.find((entry) => entry.id === activity.operationId);
  return {
    stage: 'deterministic-operation',
    operationId: activity.operationId,
    operation: activity.operation,
    activity: activity.kind ?? null,
    startedAt: activity.startedAt ?? null,
    elapsedMs: Number.isFinite(activity.elapsedMs) ? Math.max(0, Math.trunc(activity.elapsedMs)) : null,
    lastActivityAt: activity.at ?? new Date().toISOString(),
    lastOutputAt: activity.lastOutputAt ?? null,
    deadlineAt: activity.deadlineAt ?? null,
    timeoutMs: Number.isInteger(activity.timeoutMs) ? activity.timeoutMs : null,
    attempt: operationRecord?.attempts ?? 1,
    retryState: 'not-retrying',
    processAlive: typeof activity.processAlive === 'boolean' ? activity.processAlive : null,
  };
}

function capsule(state) {
  return buildContextCapsule({
    task: state.task,
    sequence: Math.max(1, state.turn + 1),
    prior: state.prior,
    runtime: { liveness: state.prior.liveness ?? null },
  });
}

function summary(liveness) {
  const label = `${liveness.operationId} (${liveness.operation})`;
  if (liveness.processAlive === false) return `Deterministic operation ${label} finished; assertions and verification are pending.`;
  const elapsed = liveness.elapsedMs == null ? 'unknown' : `${Math.ceil(liveness.elapsedMs / 1000)}s`;
  return `Deterministic operation ${label} is active; elapsed ${elapsed}.`;
}

export class LivenessProjectingPlanExecutor {
  #delegate;
  #reporter;

  constructor({ delegate, statusReporter = null }) {
    if (!delegate || typeof delegate.execute !== 'function') throw new TypeError('liveness plan executor delegate is required');
    this.#delegate = delegate;
    this.#reporter = statusReporter;
  }

  async execute({ state, persist, onLiveness = null, ...rest }) {
    return this.#delegate.execute({
      state,
      persist,
      ...rest,
      onLiveness: async (activity) => {
        await onLiveness?.(activity);
        const projected = boundedLiveness(state, activity);
        state.prior.liveness = projected;
        await persist();
        if (!this.#reporter) return;
        try {
          await this.#reporter.publish({
            issueNumber: state.task.issueNumber,
            runId: state.runId,
            revision: state.task.revision,
            stage: 'RUNNING',
            summary: summary(projected),
            capsule: capsule(state),
          });
        } catch (error) {
          state.statusError = {
            name: error?.name ?? 'Error',
            message: error?.message ?? String(error),
            at: new Date().toISOString(),
          };
          await persist();
        }
      },
    });
  }
}
