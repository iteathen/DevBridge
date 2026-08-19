import { createRuntime } from './runtime.js';
import { runIdForTask } from '../run/run-coordinator.js';

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
  const resumed = await runtime.coordinator.resumePending();
  if (resumed) {
    results.push(resumed);
    startInventoryProjection(runtime, resumed.issueNumber, inventory.record, projections, projectedIssues);
  }
  const poll = await runtime.taskSource.poll();
  for (const task of poll.tasks) {
    if (resumed?.runId === runIdForTask(task)) continue;
    startInventoryProjection(runtime, task.issueNumber, inventory.record, projections, projectedIssues);
    const result = await runtime.coordinator.executeTask(task);
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

export async function runOnce(config, options = {}) { return runCycle(await createRuntime(config, options)); }
