import { RateLimitError } from '../errors.js';
import { IssueTaskSource } from '../github/issue-task-source.js';
import { WorkspacePolicy } from '../security/workspace-policy.js';
import { assertGitHubRuntimeContext, createGitHubRuntimeContext } from './github-runtime-context.js';
import { configuredQueues } from './queue-selection.js';

function publicError(error) {
  return Object.freeze({
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: String(error?.message ?? error).slice(0, 2048),
  });
}

export async function pollOnce(config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  contextFactory = createGitHubRuntimeContext,
  sourceFactory = (options) => new IssueTaskSource(options),
} = {}) {
  const workspace = new WorkspacePolicy(config.workspace);
  await workspace.ensureRoot();
  const queues = configuredQueues(config);
  const context = assertGitHubRuntimeContext(await contextFactory({
    apiVersion: config.github.apiVersion,
    rateLimit: config.github.rateLimit,
    auth: config.github.auth,
    stateDirectory: config.state.directory,
    env,
    fetchImpl,
  }));
  const accepted = [];
  const rejected = [];
  const observations = [];
  let recommendedPollIntervalMs = config.github.pollIntervalMs;

  for (const queueRepository of queues) {
    const source = sourceFactory({
      client: context.client,
      queueRepository,
      taskLabel: config.github.taskLabel,
      trustedActorIds: config.github.trustedActorIds,
    });
    try {
      const result = await source.poll();
      recommendedPollIntervalMs = Math.max(recommendedPollIntervalMs, result.pollIntervalMs ?? 0);
      for (const entry of result.rejected ?? []) rejected.push({ ...entry, queueRepository });
      for (const task of result.tasks) {
        try {
          const projectDir = workspace.projectPath(task.envelope.target.repository);
          accepted.push({ ...task, queueRepository, projectDir });
        } catch (error) {
          rejected.push({ queueRepository, issueNumber: task.issueNumber, reason: 'local-policy', detail: error.message });
        }
      }
      observations.push({ queueRepository, ready: true, unchanged: result.unchanged === true, error: null });
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      observations.push({ queueRepository, ready: false, unchanged: false, error: publicError(error) });
    }
  }

  recommendedPollIntervalMs = Math.max(
    recommendedPollIntervalMs,
    context.rateBudget.recommendedPollIntervalMs(
      config.github.pollIntervalMs,
      { estimatedRequestsPerCycle: queues.length * 2 },
    ),
  );

  return {
    unchanged: observations.every((entry) => entry.ready && entry.unchanged),
    queues: observations,
    tasks: accepted,
    rejected,
    recommendedPollIntervalMs,
    rateLimit: context.rateBudget.snapshot(),
  };
}
