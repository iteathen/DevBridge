import { createRuntime } from './runtime.js';
import { runIdForTask } from '../run/run-coordinator.js';

export async function runCycle(runtime) {
  if (!runtime.config.execution.enabled) return { executionEnabled: false, results: [], rejected: [], recommendedPollIntervalMs: runtime.config.github.pollIntervalMs, rateLimit: runtime.rateBudget.snapshot() };
  const results = [];
  const resumed = await runtime.coordinator.resumePending();
  if (resumed) results.push(resumed);
  const poll = await runtime.taskSource.poll();
  for (const task of poll.tasks) {
    if (resumed?.runId === runIdForTask(task)) continue;
    const result = await runtime.coordinator.executeTask(task);
    if (!result.skipped) results.push(result);
  }
  return { executionEnabled: true, unchanged: poll.unchanged, results, rejected: poll.rejected ?? [], recommendedPollIntervalMs: Math.max(runtime.config.github.pollIntervalMs, poll.pollIntervalMs ?? 0), rateLimit: runtime.rateBudget.snapshot() };
}

export async function runOnce(config, options = {}) { return runCycle(await createRuntime(config, options)); }
