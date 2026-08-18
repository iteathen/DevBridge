import path from 'node:path';
import { JsonStateStore } from '../state/json-state-store.js';
import { RateBudget } from '../github/rate-budget.js';
import { GitHubRestClient } from '../github/rest-client.js';
import { IssueTaskSource } from '../github/issue-task-source.js';
import { IssueFeedbackSource } from '../github/issue-feedback-source.js';
import { IssueStatusReporter } from '../github/issue-status-reporter.js';
import { WorkspacePolicy } from '../security/workspace-policy.js';
import { GitClient } from '../git/git-client.js';
import { GitWorkspaceManager } from '../git/workspace-manager.js';
import { ProcessRunner } from '../runtime/process-runner.js';
import { RunCoordinator } from '../run/run-coordinator.js';

export function stateFileName(repository) { return `${repository.replace(/[^A-Za-z0-9_.-]+/g, '__')}.json`; }

export async function createRuntime(config, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const workspacePolicy = new WorkspacePolicy(config.workspace);
  await workspacePolicy.ensureRoot();
  const stateStore = new JsonStateStore(path.join(config.state.directory, stateFileName(config.github.queueRepository)));
  const rateBudget = new RateBudget(config.github.rateLimit);
  const tokenProvider = async () => env[config.github.tokenEnv] ?? null;
  const client = new GitHubRestClient({ apiVersion: config.github.apiVersion, tokenProvider, stateStore, rateBudget, mutationIntervalMs: config.github.rateLimit.mutationIntervalMs, fetchImpl });
  const taskSource = new IssueTaskSource({ client, queueRepository: config.github.queueRepository, taskLabel: config.github.taskLabel, trustedActorIds: config.github.trustedActorIds });
  const feedbackSource = new IssueFeedbackSource({ client, queueRepository: config.github.queueRepository, trustedActorIds: config.github.trustedActorIds });
  const secretValues = [env[config.github.tokenEnv]].filter((value) => typeof value === 'string');
  const statusReporter = new IssueStatusReporter({ client, stateStore, queueRepository: config.github.queueRepository, progressIntervalMs: config.status.progressIntervalMs, maxCommentBytes: config.status.maxCommentBytes, secretValues });
  const gitClient = new GitClient({ executable: config.git.executable, syntheticHome: path.join(config.state.directory, 'git-home'), defaultTimeoutMs: config.git.commandTimeoutMs });
  const workspaceManager = new GitWorkspaceManager({ workspacePolicy, gitClient, tokenProvider, remoteUrlResolver: (repository) => `${config.git.cloneBaseUrl}/${repository}.git`, fetchTimeoutMs: config.git.fetchTimeoutMs, branchPrefix: config.publication.branchPrefix });
  const processRunner = new ProcessRunner({ sourceEnv: env });
  const coordinator = new RunCoordinator({ stateStore, workspaceManager, processRunner, statusReporter, feedbackSource, queueRepository: config.github.queueRepository, tools: config.tools, defaultTool: config.execution.defaultTool, maxTurns: config.execution.maxTurns, allowUncontainedTools: config.execution.allowUncontainedTools, autoPushTaskBranches: config.publication.autoPushTaskBranches });
  return { config, stateStore, rateBudget, client, taskSource, feedbackSource, statusReporter, workspacePolicy, gitClient, workspaceManager, processRunner, coordinator };
}
