import path from 'node:path';
import { JsonStateStore } from '../state/json-state-store.js';
import { stateFileName } from '../state/state-file.js';
import { ChatHandoffStore } from '../context/chat-handoff.js';
import { ContextBudgetManager } from '../context/context-budget.js';
import { RateBudget } from '../github/rate-budget.js';
import { GitHubRestClient } from '../github/rest-client.js';
import { resolveGitHubCredential } from '../github/auth-provider.js';
import { IssueTaskSource } from '../github/issue-task-source.js';
import { IssueFeedbackSource } from '../github/issue-feedback-source.js';
import { IssueDecisionSource } from '../github/issue-decision-source.js';
import { IssueStatusReporter } from '../github/issue-status-reporter.js';
import { ChatHandoffProjector } from '../github/chat-handoff-projector.js';
import { ToolInventoryProjector } from '../github/tool-inventory-projector.js';
import { WorkspacePolicy } from '../security/workspace-policy.js';
import { GitClient } from '../git/git-client.js';
import { GitWorkspaceManager } from '../git/workspace-manager.js';
import { ProcessRunner } from '../runtime/process-runner.js';
import { DeterministicProcessRunner } from '../runtime/deterministic-process-runner.js';
import { createCoreOperationRegistry } from '../runtime/deterministic-operation-registry.js';
import { createCoreToolchainRegistry } from '../runtime/toolchain-registry.js';
import { DeterministicFaultInjector } from '../runtime/fault-injector.js';
import { builtInToolProfiles } from '../runtime/builtin-tool-profiles.js';
import { createSandboxManager } from '../runtime/sandbox-manager.js';
import { InventoryAwareProcessRunner, InventoryAwareStatusReporter } from '../runtime/inventory-aware-runtime.js';
import { ToolInventoryService } from '../runtime/tool-inventory-service.js';
import { CandidateDecisionGate } from '../run/candidate-decision-gate.js';
import { ControllerPlanExecutor } from '../run/controller-plan-executor.js';
import { LivenessProjectingPlanExecutor } from '../run/liveness-projecting-plan-executor.js';
import { RunCoordinator } from '../run/run-coordinator.js';

export { stateFileName } from '../state/state-file.js';

export async function createRuntime(config, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const workspacePolicy = new WorkspacePolicy(config.workspace);
  await workspacePolicy.ensureRoot();
  const stateStore = new JsonStateStore(path.join(config.state.directory, stateFileName(config.github.queueRepository)));
  const chatHandoffStore = new ChatHandoffStore({
    stateStore,
    maxBytes: config.contextRollover.maxHandoffBytes,
    maxRetained: config.contextRollover.maxRetained,
  });
  const contextBudget = config.contextRollover.enabled
    ? new ContextBudgetManager({
        unit: config.contextRollover.unit,
        capacityUnits: config.contextRollover.capacityUnits,
        softRatio: config.contextRollover.softRatio,
        preferredRatio: config.contextRollover.preferredRatio,
        hardRatio: config.contextRollover.hardRatio,
      })
    : null;
  const rateBudget = new RateBudget(config.github.rateLimit);
  const credential = await resolveGitHubCredential(config.github.auth, { env });
  const tokenProvider = async () => credential?.token ?? null;
  const client = new GitHubRestClient({ apiVersion: config.github.apiVersion, tokenProvider, stateStore, rateBudget, mutationIntervalMs: config.github.rateLimit.mutationIntervalMs, fetchImpl });
  const taskSource = new IssueTaskSource({ client, queueRepository: config.github.queueRepository, taskLabel: config.github.taskLabel, trustedActorIds: config.github.trustedActorIds });
  const feedbackSource = new IssueFeedbackSource({ client, queueRepository: config.github.queueRepository, trustedActorIds: config.github.trustedActorIds });
  const decisionSource = new IssueDecisionSource({ client, queueRepository: config.github.queueRepository, authorities: config.decisions.authorities });
  const secretValues = credential ? [credential.token] : [];
  const rawStatusReporter = new IssueStatusReporter({ client, stateStore, queueRepository: config.github.queueRepository, progressIntervalMs: config.status.progressIntervalMs, maxCommentBytes: config.status.maxCommentBytes, secretValues });
  const chatHandoffProjector = new ChatHandoffProjector({
    client,
    stateStore,
    queueRepository: config.github.queueRepository,
    maxCommentBytes: config.status.maxCommentBytes,
    secretValues,
  });
  const toolInventoryProjector = new ToolInventoryProjector({
    client,
    stateStore,
    queueRepository: config.github.queueRepository,
    maxCommentBytes: config.status.maxCommentBytes,
    secretValues,
  });
  const gitClient = new GitClient({ executable: config.git.executable, syntheticHome: path.join(config.state.directory, 'git-home'), defaultTimeoutMs: config.git.commandTimeoutMs });
  const workspaceManager = new GitWorkspaceManager({
    workspacePolicy,
    gitClient,
    tokenProvider,
    remoteUrlResolver: (repository) => `${config.git.cloneBaseUrl}/${repository}.git`,
    fetchTimeoutMs: config.git.fetchTimeoutMs,
    branchPrefix: config.publication.branchPrefix,
    baselineChannels: config.workspace.baselineChannels,
    defaultBaselineChannel: config.workspace.defaultBaselineChannel,
  });
  const sandboxManager = createSandboxManager(config.execution.sandbox, {
    env,
    allowUnsafeUncontained: config.execution.allowUncontainedTools,
  });
  const rawProcessRunner = new ProcessRunner({
    sourceEnv: env,
    mailboxRoot: path.join(config.state.directory, 'worker-mailboxes'),
    sandboxManager,
    allowUncontainedTools: config.execution.allowUncontainedTools,
  });
  const faultInjector = new DeterministicFaultInjector(config.execution.faultInjection);
  const deterministicProcessRunner = new DeterministicProcessRunner({ sourceEnv: env, faultInjector, sandboxManager });
  const toolchainRegistry = createCoreToolchainRegistry({ env });
  const operationRegistry = createCoreOperationRegistry({ toolchainRegistry });
  const deterministicControllerPlanExecutor = new ControllerPlanExecutor({
    operationRegistry,
    processRunner: deterministicProcessRunner,
    workspaceManager,
    faultInjector,
  });
  const decisionGate = config.decisions.enabled
    ? new CandidateDecisionGate({ workspaceManager, decisionSource, expiryMs: config.decisions.expiryMs })
    : null;

  const builtIns = builtInToolProfiles();
  for (const name of Object.keys(builtIns)) {
    if (Object.hasOwn(config.tools, name)) {
      throw new Error(`local tool profile name ${name} is reserved by PATCH-POLLER`);
    }
  }
  const tools = { ...config.tools, ...builtIns };
  const toolInventoryService = new ToolInventoryService({
    operationRegistry,
    toolchainRegistry,
    tools,
    deterministicProfileNames: Object.keys(builtIns),
    modelAdaptersEnabled: config.execution.modelAdaptersEnabled,
    allowUncontainedTools: config.execution.allowUncontainedTools,
    sandboxManager,
    env,
  });
  await toolInventoryService.initialize();
  const statusReporter = new InventoryAwareStatusReporter({ delegate: rawStatusReporter, inventoryService: toolInventoryService, projector: toolInventoryProjector });
  const processRunner = new InventoryAwareProcessRunner({ delegate: rawProcessRunner, inventoryService: toolInventoryService });
  const controllerPlanExecutor = new LivenessProjectingPlanExecutor({
    delegate: deterministicControllerPlanExecutor,
    statusReporter,
  });

  const coordinator = new RunCoordinator({
    stateStore,
    workspaceManager,
    processRunner,
    controllerPlanExecutor,
    statusReporter,
    feedbackSource,
    decisionGate,
    queueRepository: config.github.queueRepository,
    tools,
    defaultTool: config.execution.defaultTool,
    maxTurns: config.execution.maxTurns,
    allowUncontainedTools: config.execution.allowUncontainedTools,
    controllerPlansEnabled: config.execution.controllerPlansEnabled,
    modelAdaptersEnabled: config.execution.modelAdaptersEnabled,
    deterministicProfileNames: Object.keys(builtIns),
    autoPushTaskBranches: config.publication.autoPushTaskBranches,
    forceNoOpPublication: config.publication.forceNoOpPublication,
  });
  return {
    config,
    stateStore,
    chatHandoffStore,
    chatHandoffProjector,
    contextBudget,
    rateBudget,
    client,
    taskSource,
    feedbackSource,
    decisionSource,
    rawStatusReporter,
    statusReporter,
    toolInventoryProjector,
    toolInventoryService,
    workspacePolicy,
    gitClient,
    workspaceManager,
    sandboxManager,
    rawProcessRunner,
    processRunner,
    deterministicProcessRunner,
    faultInjector,
    toolchainRegistry,
    operationRegistry,
    controllerPlanExecutor,
    decisionGate,
    coordinator,
  };
}
