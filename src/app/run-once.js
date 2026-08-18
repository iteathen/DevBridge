import { createRuntime } from './runtime.js';
import { runIdForTask } from '../run/run-coordinator.js';

function recommendedPollInterval(runtime, observedPollIntervalMs = 0) {
  const configured = Math.max(runtime.config.github.pollIntervalMs, observedPollIntervalMs ?? 0);
  return runtime.rateBudget.recommendedPollIntervalMs(configured, { estimatedRequestsPerCycle: 2 });
}

async function refreshInventory(runtime) {
  if (!runtime.config.inventory.enabled || !runtime.toolInventory) return null;
  const record = await runtime.toolInventory.refresh({ probeVersions: false });
  if (runtime.config.inventory.projectionIssueNumber && runtime.toolInventoryProjector) {
    await runtime.toolInventoryProjector.project({ issueNumber: runtime.config.inventory.projectionIssueNumber, record });
  }
  return { digest: record.digest, generation: record.generation };
}

export async function runCycle(runtime) {
  if (!runtime.config.execution.enabled) {
    const inventory = await refreshInventory(runtime);
    return {
      executionEnabled: false,
      results: [],
      rejected: [],
      toolInventory: inventory,
      recommendedPollIntervalMs: recommendedPollInterval(runtime),
      rateLimit: runtime.rateBudget.snapshot()
    };
  }
  const results = [];
  const resumed = await runtime.coordinator.resumePending();
  if (resumed) results.push(resumed);
  const poll = await runtime.taskSource.poll();
  for (const task of poll.tasks) {
    if (resumed?.runId === runIdForTask(task)) continue;
    const result = await runtime.coordinator.executeTask(task);
    if (!result.skipped) results.push(result);
  }
  const inventory = await refreshInventory(runtime);
  return {
    executionEnabled: true,
    unchanged: poll.unchanged,
    results,
    rejected: poll.rejected ?? [],
    toolInventory: inventory,
    recommendedPollIntervalMs: recommendedPollInterval(runtime, poll.pollIntervalMs ?? 0),
    rateLimit: runtime.rateBudget.snapshot()
  };
}

export async function runOnce(config, options = {}) { return runCycle(await createRuntime(config, options)); }
