import { RateLimitError } from '../errors.js';
import { RUNTIME_COLLECTION_PROTOCOL } from './runtime-collection.js';
import { runCycle } from './runtime-cycle.js';

function assertCollection(value) {
  if (!value || value.protocol !== RUNTIME_COLLECTION_PROTOCOL || !Array.isArray(value.runtimes)
      || value.runtimes.length === 0 || !value.githubContext?.rateBudget) {
    throw new TypeError('runtime collection contract is incomplete');
  }
  return value;
}

function publicError(error) {
  return Object.freeze({
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: String(error?.message ?? error).slice(0, 2048),
  });
}

function queueBound(values, subject) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error('runtime collection member returned an invalid result list');
  return values.map((value) => Object.freeze({
    ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
    queueRepository: subject,
  }));
}

export async function runRuntimeCollectionCycle(collection, {
  cycle = runCycle,
  onRuntimeError = null,
} = {}) {
  const selected = assertCollection(collection);
  if (typeof cycle !== 'function') throw new TypeError('runtime collection cycle contract is invalid');
  if (onRuntimeError != null && typeof onRuntimeError !== 'function') throw new TypeError('runtime collection error contract is invalid');
  const queues = [];
  const results = [];
  const rejected = [];
  const inventories = [];
  const projections = [];
  let recommendedPollIntervalMs = selected.config.github.pollIntervalMs;

  for (const runtime of selected.runtimes) {
    const subject = runtime.queueRepository;
    try {
      const observed = await cycle(runtime);
      recommendedPollIntervalMs = Math.max(recommendedPollIntervalMs, observed.recommendedPollIntervalMs ?? 0);
      results.push(...queueBound(observed.results, subject));
      rejected.push(...queueBound(observed.rejected, subject));
      projections.push(...queueBound(observed.inventoryProjections, subject));
      inventories.push(Object.freeze({
        queueRepository: subject,
        reference: observed.toolInventory ?? null,
        error: observed.toolInventoryError ?? null,
      }));
      queues.push(Object.freeze({
        queueRepository: subject,
        ready: true,
        unchanged: observed.unchanged === true,
        resultCount: observed.results?.length ?? 0,
        rejectedCount: observed.rejected?.length ?? 0,
        error: null,
        remoteReport: null,
      }));
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      let remoteReport = null;
      if (onRuntimeError != null) {
        try { remoteReport = await onRuntimeError(runtime, error); }
        catch (reportError) {
          remoteReport = Object.freeze({ reported: false, reason: 'runtime-error-report-failed', error: publicError(reportError) });
        }
      }
      queues.push(Object.freeze({
        queueRepository: subject,
        ready: false,
        unchanged: false,
        resultCount: 0,
        rejectedCount: 0,
        error: publicError(error),
        remoteReport,
      }));
    }
  }

  recommendedPollIntervalMs = Math.max(
    recommendedPollIntervalMs,
    selected.githubContext.rateBudget.recommendedPollIntervalMs(
      selected.config.github.pollIntervalMs,
      { estimatedRequestsPerCycle: selected.runtimes.length * 2 },
    ),
  );

  return Object.freeze({
    executionEnabled: selected.config.execution.enabled === true,
    unchanged: queues.every((entry) => entry.ready && entry.unchanged),
    queues: Object.freeze(queues),
    results: Object.freeze(results),
    rejected: Object.freeze(rejected),
    toolInventories: Object.freeze(inventories),
    inventoryProjections: Object.freeze(projections),
    recommendedPollIntervalMs,
    rateLimit: selected.githubContext.rateBudget.snapshot(),
  });
}
