import { RateLimitError } from '../errors.js';
import { IssueTaskSource } from '../github/issue-task-source.js';
import { RepositoryCatalog } from '../github/repository-catalog.js';
import { WorkspacePolicy } from '../security/workspace-policy.js';
import { createGitHubSession } from './github-session.js';

export async function pollOnce(config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  sessionFactory = createGitHubSession,
  catalogFactory = (options) => new RepositoryCatalog(options),
} = {}) {
  const workspace = new WorkspacePolicy(config.workspace);
  await workspace.ensureRoot();
  const session = await sessionFactory(config, { env, fetchImpl });
  const catalog = catalogFactory({
    client: session.client,
    stateStore: session.stateStore,
    configuredRepositories: config.github.queueRepositories,
    allowedOwners: config.workspace.allowedOwners,
    discovery: config.github.repositoryDiscovery,
  });
  if (!catalog || typeof catalog.list !== 'function') throw new TypeError('repository catalog contract is incomplete');
  const selection = await catalog.list();
  if (!Array.isArray(selection.repositories) || selection.repositories.length === 0) {
    throw new Error('repository selection produced no queue repositories');
  }
  const accepted = [];
  const rejected = [];
  const errors = [];
  const unchanged = [];
  for (const queueRepository of selection.repositories) {
    const source = new IssueTaskSource({
      client: session.client,
      queueRepository,
      taskLabel: config.github.taskLabel,
      trustedActorIds: config.github.trustedActorIds,
    });
    try {
      const result = await source.poll();
      unchanged.push(result.unchanged === true);
      rejected.push(...(result.rejected ?? []).map((entry) => ({ queueRepository, ...entry })));
      for (const task of result.tasks) {
        try {
          const projectDir = workspace.projectPath(task.envelope.target.repository);
          accepted.push({ ...task, projectDir });
        } catch (error) {
          rejected.push({ queueRepository, issueNumber: task.issueNumber, reason: 'local-policy', detail: error.message });
        }
      }
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      errors.push({ queueRepository, error: { name: error.name, message: error.message } });
    }
  }
  const requestEstimate = Math.min(100, Math.max(1, selection.repositories.length * 2));
  return {
    repositories: selection.records,
    discovery: {
      enabled: selection.discoveryEnabled,
      discoveredCount: selection.discoveredCount,
      unchanged: selection.unchanged,
      truncated: selection.truncated,
    },
    unchanged: errors.length === 0 && unchanged.every(Boolean),
    tasks: accepted,
    rejected,
    errors,
    recommendedPollIntervalMs: session.rateBudget.recommendedPollIntervalMs(config.github.pollIntervalMs, { estimatedRequestsPerCycle: requestEstimate }),
    rateLimit: session.rateBudget.snapshot(),
  };
}
