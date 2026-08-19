import { TaskLeaseLostError } from '../errors.js';
import { createRuntime } from './runtime.js';
import { runIdForTask } from '../run/run-coordinator.js';

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

async function reconcileOnboarding(runtime) {
  if (!runtime.toolOnboarding) return { changed: false, events: [], error: null };
  try {
    return { ...(await runtime.toolOnboarding.reconcile()), error: null };
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
  const entries = await runtime.stateStore.entries(`run.${runtime.config.github.queueRepository}#`);
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

async function executeTask(runtime, task) {
  if (!runtime.taskLeaseManager) return runtime.coordinator.executeTask(task);
  const claim = await runtime.taskLeaseManager.begin(task);
  if (!claim.acquired) return leaseDeferral(task, claim);
  const { handle } = claim;
  let result;
  try {
    result = await runtime.leaseExecutionContext.run(handle, () => runtime.coordinator.executeTask(task));
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

export async function runCycle(runtime) {
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
      recommendedPollIntervalMs: recommendedPollInterval(runtime),
      rateLimit: runtime.rateBudget.snapshot()
    };
  }
  const results = [];
  const pendingTask = await oldestPendingTask(runtime);
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
    if (resumedRunId === runIdForTask(task)) continue;
    startInventoryProjection(runtime, task.issueNumber, inventory.record, projections, projectedIssues);
    const result = await executeTask(runtime, task);
    if (!result.skipped) results.push(result);
  }

  // Dynamic onboarding is deliberately outside the dispatch critical path.
  // A locally pre-authorized unfamiliar CLI may take time to sandbox/probe;
  // current tasks use the inventory they were actually given and any newly
  // registered operation becomes visible only after this reconciliation.
  const toolOnboarding = await reconcileOnboarding(runtime);
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
    recommendedPollIntervalMs: recommendedPollInterval(runtime, poll.pollIntervalMs ?? 0),
    rateLimit: runtime.rateBudget.snapshot()
  };
}

export async function runOnce(config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  runtimeFactory = createRuntime,
} = {}) {
  return runCycle(await runtimeFactory(config, { env, fetchImpl, coordinationExclusive: false }));
}
