import path from 'node:path';
import { JsonStateStore } from '../state/json-state-store.js';
import { RateBudget } from '../github/rate-budget.js';
import { GitHubRestClient } from '../github/rest-client.js';
import { IssueTaskSource } from '../github/issue-task-source.js';
import { WorkspacePolicy } from '../security/workspace-policy.js';

function stateFileName(repository) {
  return `${repository.replace(/[^A-Za-z0-9_.-]+/g, '__')}.json`;
}

export async function pollOnce(config, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const workspace = new WorkspacePolicy(config.workspace);
  await workspace.ensureRoot();

  const store = new JsonStateStore(path.join(config.state.directory, stateFileName(config.github.queueRepository)));
  const budget = new RateBudget(config.github.rateLimit);
  const client = new GitHubRestClient({
    apiVersion: config.github.apiVersion,
    tokenProvider: async () => env[config.github.tokenEnv] ?? null,
    stateStore: store,
    rateBudget: budget,
    mutationIntervalMs: config.github.rateLimit.mutationIntervalMs,
    fetchImpl
  });
  const source = new IssueTaskSource({
    client,
    queueRepository: config.github.queueRepository,
    taskLabel: config.github.taskLabel,
    trustedActorIds: config.github.trustedActorIds
  });

  const result = await source.poll();
  const accepted = [];
  const rejected = [...(result.rejected ?? [])];

  for (const task of result.tasks) {
    try {
      const projectDir = workspace.projectPath(task.envelope.target.repository);
      accepted.push({ ...task, projectDir });
    } catch (error) {
      rejected.push({ issueNumber: task.issueNumber, reason: 'local-policy', detail: error.message });
    }
  }

  return {
    unchanged: result.unchanged,
    tasks: accepted,
    rejected,
    recommendedPollIntervalMs: Math.max(config.github.pollIntervalMs, result.pollIntervalMs ?? 0),
    rateLimit: budget.snapshot()
  };
}
