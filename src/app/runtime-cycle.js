import { RateLimitError, TaskLeaseLostError } from '../errors.js';
import { runIdForTask, terminalStatusForRun } from '../run/run-coordinator.js';
import { reportTaskRuntimeError } from './runtime-error-report.js';

const TERMINAL_RUN_STAGES = new Set(['completed', 'failed', 'cancelled']);
const RETAIN_LEASE_STATUSES = new Set(['waiting-feedback', 'waiting-decision']);

function recommendedPollInterval(runtime, observedPollIntervalMs = 0) {
  const configured = Math.max(runtime.config.github.pollIntervalMs, observedPollIntervalMs ?? 0);
  return runtime.rateBudget.recommendedPollIntervalMs(configured, { estimatedRequestsPerCycle: 2 });
}
async function refreshInventory(runtime) {
  if (!runtime.toolInventory) return { record: null, reference: null, error: null };
  try {
    const record = await runtime.toolInventory.refresh();
    return { record, reference: runtime.toolInventory.reference(), error: null };
  } catch (error) {
    return {
      record: null,
      reference: runtime.toolInventory.reference?.() ?? null,
      error: { name: error.name, message: error.message },
    };
  }
}

async function reconcileOnboarding(runtime, task = null) {
  if (!runtime.toolOnboarding) return { changed: false, events: [], error: null };
  try {
    const context = task == null ? null : {
      repository: task.envelope.target.repository,
      repositoryId: null,
      runId: runIdForTask(task),
    };
    return { ...(await runtime.toolOnboarding.reconcile(context)), error: null };
  } catch (error) {
    return {
      changed: false,
      events: [],
      error: { name: error.name, message: error.message },
    };
  }
}

function startInventoryProjection(runtime, issueNumber, record, projections, projectedIssues) {
  if (!runtime.toolInventoryProjector || !record || !Number.isSafeInteger(issueNumber) || projectedIssues.has(issueNumber)) return;
  projectedIssues.add(issueNumber);
  projections.push(runtime.toolInventoryProjector.project({ issueNumber, record })
    .then((result) => ({ issueNumber, ...result }))
    .catch((error) => ({ issueNumber, projected: false, reason: 'projection-failed', error: { name: error.name, message: error.message } })));
}

async function oldestPendingTask(runtime) {
  const entries = await runtime.stateStore.entries(`run.${runtime.queueRepository}#`);
  const pending = entries
    .map(([, value]) => value)
    .filter((state) => state?.task && !TERMINAL_RUN_STAGES.has(state.stage))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return pending[0]?.task ?? null;
}

function leaseDeferral(task, claim, status = 'deferred-lease') {
  return {
    runId: runIdForTask(task),
    issueNumber: task.issueNumber,
    status,
    deferred: true,
    lease: {
      reason: claim.reason ?? null,
      ownerAddress: claim.ownerAddress ?? null,
      expiresAt: claim.expiresAt ?? null,
      epoch: claim.epoch ?? null,
      commitSha: claim.commitSha ?? null,
    },
  };
}

async function executeTask(runtime, task, action = null) {
  const perform = action ?? (async () => {
    try { return await runtime.coordinator.executeTask(task); }
    catch (error) {
      if (!(error instanceof TaskLeaseLostError)) {
        // This is still inside the original task's lease and exact dispatch.
        // Reporting failure does not replace the original runtime exception.
        try { await reportTaskRuntimeError(runtime, task, error); } catch { /* Durable status intent remains pending. */ }
      }
      throw error;
    }
  });
  if (!runtime.taskLeaseManager) return perform();
  const claim = await runtime.taskLeaseManager.begin(task);
  if (!claim.acquired) return leaseDeferral(task, claim);
  const { handle } = claim;
  let result;
  try {
    result = await runtime.leaseExecutionContext.run(handle, perform);
  } catch (error) {
    if (error instanceof TaskLeaseLostError || handle.signal.aborted) {
      return leaseDeferral(task, {
        reason: 'lease-lost',
        ownerAddress: null,
        expiresAt: handle.expiresAt,
        epoch: handle.epoch,
        commitSha: handle.commitSha,
      }, 'deferred-lease-lost');
    }
    try { await runtime.taskLeaseManager.release(handle); }
    catch { runtime.taskLeaseManager.stopHeartbeat(handle); }
    throw error;
  }

  if (RETAIN_LEASE_STATUSES.has(result?.status) || result?.waiting === true) {
    try {
      const retained = runtime.taskLeaseManager.retain(handle);
      return { ...result, lease: { retained: true, commitSha: retained.commitSha, epoch: retained.epoch, expiresAt: retained.expiresAt } };
    } catch (error) {
      if (error instanceof TaskLeaseLostError || handle.signal.aborted) {
        return leaseDeferral(task, {
          reason: 'lease-lost',
          expiresAt: handle.expiresAt,
          epoch: handle.epoch,
          commitSha: handle.commitSha,
        }, 'deferred-lease-lost');
      }
      throw error;
    }
  }

  try {
    const released = await runtime.taskLeaseManager.release(handle);
    return {
      ...result,
      lease: {
        released: released.released === true,
        reason: released.reason ?? null,
        commitSha: released.commitSha ?? handle.commitSha,
        epoch: released.epoch ?? handle.epoch,
      },
    };
  } catch (error) {
    runtime.taskLeaseManager.stopHeartbeat(handle);
    return {
      ...result,
      lease: {
        released: false,
        reason: 'release-error',
        commitSha: handle.commitSha,
        epoch: handle.epoch,
        error: { name: error.name, message: error.message },
      },
    };
  }
}

async function reconcileStatusDelivery(runtime) {
  if (typeof runtime.statusReporter?.pending !== 'function') return [];
  const pending = await runtime.statusReporter.pending();
  const runs = await runtime.stateStore.entries(`run.${runtime.queueRepository}#`);
  // Terminal state itself records delivery intent before the reporter can run.
  // This closes the crash window between terminal run persistence and publish.
  for (const [, state] of runs) {
    if (state?.statusDeliveryPending !== true || !TERMINAL_RUN_STAGES.has(state.stage) || !state.task) continue;
    if (!pending.some(subject => subject.runId === state.runId && subject.revision === state.task.revision)) {
      pending.push({ issueNumber: state.task.issueNumber, runId: state.runId, revision: state.task.revision });
    }
  }
  const results = [];
  // Match the existing task source's 30-subject admission/read budget. This is
  // one bounded phase of the existing cycle, never another scheduler.
  for (const subject of pending.slice(0, 30)) {
    let state = await runtime.stateStore.get(`run.${runtime.queueRepository}#${subject.issueNumber}.${subject.revision}`);
    if (!state?.task || state.runId !== subject.runId || state.task.queueRepository !== runtime.queueRepository
        || state.runId !== runIdForTask(state.task) || state.task.issueNumber !== subject.issueNumber || state.task.revision !== subject.revision) {
      results.push({ ...subject, published: false, reason: 'task-correlation-unavailable' });
      continue;
    }
    try {
      const result = await executeTask(runtime, state.task, async () => {
        // Re-read after acquiring the lease; an earlier owner may have advanced
        // this run while the claim was in flight.
        const latest = await runtime.stateStore.get(`run.${runtime.queueRepository}#${subject.issueNumber}.${subject.revision}`);
        if (!latest?.task || latest.runId !== subject.runId || latest.task.queueRepository !== runtime.queueRepository
            || latest.task.issueNumber !== subject.issueNumber || latest.task.revision !== subject.revision) {
          return { published: false, reason: 'task-correlation-unavailable' };
        }
        state = latest;
        const delivery = state.statusDeliveryPending === true && TERMINAL_RUN_STAGES.has(state.stage)
          ? await runtime.statusReporter.publish(terminalStatusForRun(state))
          : await runtime.statusReporter.reconcile(subject);
        if (TERMINAL_RUN_STAGES.has(state.stage) && (delivery?.published || delivery?.reason === 'already-reported')) {
          state.statusDeliveryPending = false;
          await runtime.stateStore.set(`run.${runtime.queueRepository}#${subject.issueNumber}.${subject.revision}`, state);
        }
        return { ...delivery, status: state.stage, waiting: !TERMINAL_RUN_STAGES.has(state.stage) };
      });
      results.push({ ...subject, ...result });
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      results.push({ ...subject, published: false, reason: 'delivery-unavailable' });
    }
  }
  return results;
}

export async function runCycle(runtime) {
  const statusDeliveries = await reconcileStatusDelivery(runtime);
  let inventory = await refreshInventory(runtime);
  const projections = [];
  const projectedIssues = new Set();
  if (!runtime.config.execution.enabled) {
    return {
      executionEnabled: false,
      results: [],
      rejected: [],
      toolInventory: inventory.reference,
      toolInventoryError: inventory.error,
      toolOnboarding: { changed: false, events: [], error: null },
      inventoryProjections: [],
      statusDeliveries,
      recommendedPollIntervalMs: recommendedPollInterval(runtime),
      rateLimit: runtime.rateBudget.snapshot()
    };
  }
  const results = [];
  const pendingTask = await oldestPendingTask(runtime);
  let onboardingTask = pendingTask;
  let resumedRunId = null;
  if (pendingTask) {
    resumedRunId = runIdForTask(pendingTask);
    const resumed = await executeTask(runtime, pendingTask);
    if (resumed) {
      results.push(resumed);
      startInventoryProjection(runtime, resumed.issueNumber, inventory.record, projections, projectedIssues);
    }
  }
  const poll = await runtime.taskSource.poll();
  for (const task of poll.tasks) {
    onboardingTask ??= task;
    if (resumedRunId === runIdForTask(task)) continue;
    startInventoryProjection(runtime, task.issueNumber, inventory.record, projections, projectedIssues);
    const result = await executeTask(runtime, task);
    if (!result.skipped) results.push(result);
  }

  // Dynamic onboarding is deliberately outside the dispatch critical path.
  // A locally pre-authorized unfamiliar CLI may take time to probe;
  // current tasks use the inventory they were actually given and any newly
  // registered operation becomes visible only after this reconciliation.
  const toolOnboarding = await reconcileOnboarding(runtime, onboardingTask);
  if (toolOnboarding.changed) inventory = await refreshInventory(runtime);

  const inventoryProjections = await Promise.all(projections);
  return {
    executionEnabled: true,
    unchanged: poll.unchanged,
    results,
    rejected: poll.rejected ?? [],
    toolInventory: inventory.reference,
    toolInventoryError: inventory.error,
    toolOnboarding,
    inventoryProjections,
    statusDeliveries,
    recommendedPollIntervalMs: recommendedPollInterval(runtime, poll.pollIntervalMs ?? 0),
    rateLimit: runtime.rateBudget.snapshot()
  };
}
