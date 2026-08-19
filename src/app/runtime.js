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
import { createDeterministicSandboxProvider } from '../runtime/deterministic-sandbox.js';
import { WorkerExchange } from '../runtime/worker-exchange.js';
import { createCoreOperationRegistry } from '../runtime/deterministic-operation-registry.js';
import { createCoreToolchainRegistry } from '../runtime/toolchain-registry.js';
import { ToolInventoryService } from '../runtime/tool-inventory.js';
import { DeterministicFaultInjector } from '../runtime/fault-injector.js';
import { builtInToolProfiles, builtInToolReadRoots } from '../runtime/builtin-tool-profiles.js';
import { ControllerPlanExecutor } from '../run/controller-plan-executor.js';
import { LivenessProjectingPlanExecutor } from '../run/liveness-projecting-plan-executor.js';
import { RunCoordinator } from '../run/run-coordinator.js';
import { HardGateController } from '../run/hard-gate-controller.js';
import { DecisionGatedRunCoordinator, DecisionGatedWorkspaceManager } from '../run/decision-gated-coordinator.js';

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
  const decisionSource = new IssueDecisionSource({ client, queueRepository: config.github.queueRepository });
  const secretValues = credential ? [credential.token] : [];
  let toolInventory = null;
  const statusReporter = new IssueStatusReporter({
    client,
    stateStore,
    queueRepository: config.github.queueRepository,
    progressIntervalMs: config.status.progressIntervalMs,
    maxCommentBytes: config.status.maxCommentBytes,
    secretValues,
    inventoryRefProvider: () => toolInventory?.reference() ?? null,
  });
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
  const hardGateController = new HardGateController({
    decisionSource,
    decisionAuthorities: config.execution.decisionAuthorities,
    approvalTtlMs: config.execution.decisionApprovalTtlMs,
    architectureFileThreshold: config.execution.architectureGateFileThreshold,
    architectureOwnerThreshold: config.execution.architectureGateOwnerThreshold,
  });
  const gatedWorkspaceManager = new DecisionGatedWorkspaceManager({
    delegate: workspaceManager,
    stateStore,
    queueRepository: config.github.queueRepository,
    gateController: hardGateController,
  });
  const faultInjector = new DeterministicFaultInjector(config.execution.faultInjection);
  const deterministicSandboxProvider = createDeterministicSandboxProvider({
    externalReadRoots: config.workspace.externalReadRoots,
    workspaceRoot: config.workspace.root,
    stateDirectory: config.state.directory,
    env,
  });
  const workerExchange = new WorkerExchange({ stateDirectory: config.state.directory });
  const processRunner = new ProcessRunner({
    sourceEnv: env,
    workerExchange,
    sandboxProvider: deterministicSandboxProvider,
    trustedReadRootsByProfile: builtInToolReadRoots(),
  });
  const deterministicProcessRunner = new DeterministicProcessRunner({
    sourceEnv: env,
    faultInjector,
    sandboxProvider: deterministicSandboxProvider,
  });
  const toolchainRegistry = createCoreToolchainRegistry({ env });
  const operationRegistry = createCoreOperationRegistry({ toolchainRegistry });
  const deterministicControllerPlanExecutor = new ControllerPlanExecutor({
    operationRegistry,
    processRunner: deterministicProcessRunner,
    // Deterministic plan work uses the raw workspace manager. The hard gate is
    // deliberately applied only at the final candidate-sealing frontier.
    workspaceManager,
    faultInjector,
  });
  const controllerPlanExecutor = new LivenessProjectingPlanExecutor({
    delegate: deterministicControllerPlanExecutor,
    statusReporter,
  });

  const builtIns = builtInToolProfiles();
  for (const name of Object.keys(builtIns)) {
    if (Object.hasOwn(config.tools, name)) {
      throw new Error(`local tool profile name ${name} is reserved by PATCH-POLLER`);
    }
  }
  const deterministicProfileNames = Object.keys(builtIns);
  const tools = { ...config.tools, ...builtIns };
  toolInventory = new ToolInventoryService({
    operationRegistry,
    toolchainRegistry,
    sandboxProvider: deterministicSandboxProvider,
    profiles: tools,
    deterministicProfileNames,
    modelAdaptersEnabled: config.execution.modelAdaptersEnabled,
    allowUncontainedTools: config.execution.allowUncontainedTools,
    env,
    runtimeIdentity: { version: '0.1.0' },
  });
  await toolInventory.refresh();

  const baseCoordinator = new RunCoordinator({
    stateStore,
    workspaceManager: gatedWorkspaceManager,
    processRunner,
    controllerPlanExecutor,
    statusReporter,
    feedbackSource,
    queueRepository: config.github.queueRepository,
    tools,
    defaultTool: config.execution.defaultTool,
    maxTurns: config.execution.maxTurns,
    allowUncontainedTools: config.execution.allowUncontainedTools,
    controllerPlansEnabled: config.execution.controllerPlansEnabled,
    modelAdaptersEnabled: config.execution.modelAdaptersEnabled,
    deterministicProfileNames,
    autoPushTaskBranches: config.publication.autoPushTaskBranches,
    forceNoOpPublication: config.publication.forceNoOpPublication,
  });
  const coordinator = new DecisionGatedRunCoordinator({
    delegate: baseCoordinator,
    stateStore,
    statusReporter,
    gateController: hardGateController,
    queueRepository: config.github.queueRepository,
    maxTurns: config.execution.maxTurns,
  });
  return {
    config,
    stateStore,
    chatHandoffStore,
    chatHandoffProjector,
    toolInventory,
    toolInventoryProjector,
    contextBudget,
    rateBudget,
    client,
    taskSource,
    feedbackSource,
    decisionSource,
    statusReporter,
    workspacePolicy,
    gitClient,
    workspaceManager,
    gatedWorkspaceManager,
    hardGateController,
    processRunner,
    workerExchange,
    deterministicProcessRunner,
    deterministicSandboxProvider,
    faultInjector,
    toolchainRegistry,
    operationRegistry,
    controllerPlanExecutor,
    baseCoordinator,
    coordinator,
  };
}
