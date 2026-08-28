import path from 'node:path';
import { JsonStateStore } from '../state/json-state-store.js';
import { stateFileName } from '../state/state-file.js';
import { ChatHandoffStore } from '../context/chat-handoff.js';
import { ContextBudgetManager } from '../context/context-budget.js';
import { IssueTaskSource } from '../github/issue-task-source.js';
import { IssueFeedbackSource } from '../github/issue-feedback-source.js';
import { IssueDecisionSource } from '../github/issue-decision-source.js';
import { IssueStatusReporter } from '../github/issue-status-reporter.js';
import { ChatHandoffProjector } from '../github/chat-handoff-projector.js';
import { ToolInventoryProjector } from '../github/tool-inventory-projector.js';
import { importAgentPublicIdentity, loadOrCreateAgentIdentity } from '../security/agent-identity.js';
import { WorkspacePolicy } from '../security/workspace-policy.js';
import { GitClient } from '../git/git-client.js';
import { GitTaskLeaseStore } from '../git/task-lease-store.js';
import { GitWorkspaceManager } from '../git/workspace-manager.js';
import { DeterministicProcessRunner } from '../runtime/deterministic-process-runner.js';
import { WorkerExchange } from '../runtime/worker-exchange.js';
import { createCoreOperationRegistry } from '../runtime/deterministic-operation-registry.js';
import { loadLocalOperationManifests } from '../runtime/local-operation-manifest.js';
import { ToolOnboarding } from '../runtime/tool-onboarding.js';
import { canonicalExternalDirectory } from '../runtime/external-directory.js';
import { createSetupStatusOperation } from '../setup/status-operation.js';
import { createSetupStatusObserver } from '../setup/status-observer.js';
import { connectToolOnboarding } from './tool-onboarding-composition.js';
import { composeWorkRunner } from './work-runner-composition.js';
import { createCoreToolchainRegistry } from '../runtime/toolchain-registry.js';
import { ToolInventoryService } from '../runtime/tool-inventory.js';
import { DeterministicFaultInjector } from '../runtime/fault-injector.js';
import { builtInToolProfiles } from '../runtime/builtin-tool-profiles.js';
import { ControllerPlanExecutor } from '../run/controller-plan-executor.js';
import { LeaseExecutionContext } from '../run/lease-execution-context.js';
import { LivenessProjectingPlanExecutor } from '../run/liveness-projecting-plan-executor.js';
import { RunCoordinator } from '../run/run-coordinator.js';
import { TaskLeaseManager } from '../run/task-lease-manager.js';
import { HardGateController } from '../run/hard-gate-controller.js';
import { DecisionGatedRunCoordinator, DecisionGatedWorkspaceManager } from '../run/decision-gated-coordinator.js';
import { createRuntimeExecutionContext } from './runtime-execution.js';
import { assertGitHubRuntimeContext, createGitHubRuntimeContext } from './github-runtime-context.js';
import { selectConfiguredQueue } from './queue-selection.js';

export { stateFileName } from '../state/state-file.js';

function coordinationDefaults(config) {
  return config.coordination ?? {
    enabled: false,
    handle: 'agent',
    leaseTtlMs: 1_200_000,
    heartbeatIntervalMs: 300_000,
    clockSkewMs: 60_000,
    trustedPeers: [],
  };
}

export async function createRuntime(config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  coordinationExclusive = false,
  queueRepository = null,
  githubContext = null,
} = {}) {
  if (typeof coordinationExclusive !== 'boolean') throw new TypeError('createRuntime coordinationExclusive must be a boolean');
  if (queueRepository == null) throw new TypeError('runtime queue must be selected explicitly');
  const selectedQueue = selectConfiguredQueue(config, queueRepository);
  const workspacePolicy = new WorkspacePolicy(config.workspace);
  await workspacePolicy.ensureRoot();
  const stateStore = new JsonStateStore(path.join(config.state.directory, stateFileName(selectedQueue)));
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
  const sharedGitHub = githubContext == null
    ? await createGitHubRuntimeContext({
        apiVersion: config.github.apiVersion,
        rateLimit: config.github.rateLimit,
        auth: config.github.auth,
        stateDirectory: config.state.directory,
        env,
        fetchImpl,
      })
    : assertGitHubRuntimeContext(githubContext);
  const { rateBudget, tokenProvider, client, secretValues } = sharedGitHub;
  const taskSource = new IssueTaskSource({ client, queueRepository: selectedQueue, taskLabel: config.github.taskLabel, trustedActorIds: config.github.trustedActorIds });
  const feedbackSource = new IssueFeedbackSource({ client, queueRepository: selectedQueue, trustedActorIds: config.github.trustedActorIds });
  const decisionSource = new IssueDecisionSource({ client, queueRepository: selectedQueue });
  let toolInventory = null;
  const statusReporter = new IssueStatusReporter({
    client,
    stateStore,
    queueRepository: selectedQueue,
    progressIntervalMs: config.status.progressIntervalMs,
    maxCommentBytes: config.status.maxCommentBytes,
    secretValues,
    inventoryRefProvider: () => toolInventory?.reference() ?? null,
  });
  const chatHandoffProjector = new ChatHandoffProjector({
    client,
    stateStore,
    queueRepository: selectedQueue,
    maxCommentBytes: config.status.maxCommentBytes,
    secretValues,
  });
  const toolInventoryProjector = new ToolInventoryProjector({
    client,
    stateStore,
    queueRepository: selectedQueue,
    maxCommentBytes: config.status.maxCommentBytes,
    secretValues,
  });
  const coordination = coordinationDefaults(config);
  const agentIdentity = coordination.enabled
    ? await loadOrCreateAgentIdentity({ directory: config.state.directory, handle: coordination.handle })
    : null;
  const effectiveBranchPrefix = agentIdentity
    ? `${config.publication.branchPrefix}/${agentIdentity.fingerprint}`
    : config.publication.branchPrefix;
  const gitClient = new GitClient({ executable: config.git.executable, syntheticHome: path.join(config.state.directory, 'git-home'), defaultTimeoutMs: config.git.commandTimeoutMs });
  const workspaceManager = new GitWorkspaceManager({
    workspacePolicy,
    gitClient,
    tokenProvider,
    remoteUrlResolver: (repository) => `${config.git.cloneBaseUrl}/${repository}.git`,
    fetchTimeoutMs: config.git.fetchTimeoutMs,
    branchPrefix: effectiveBranchPrefix,
    baselineChannels: config.workspace.baselineChannels,
    defaultBaselineChannel: config.workspace.defaultBaselineChannel,
  });
  let taskLeaseStore = null;
  let taskLeaseManager = null;
  if (agentIdentity) {
    const trustedIdentities = new Map();
    for (const peerConfig of coordination.trustedPeers) {
      const peer = importAgentPublicIdentity(peerConfig);
      if (peer.fingerprint !== peerConfig.fingerprint) throw new Error(`coordination peer ${peerConfig.handle} fingerprint changed after configuration validation`);
      trustedIdentities.set(peer.fingerprint, peer);
    }
    taskLeaseStore = new GitTaskLeaseStore({
      workspaceManager,
      gitClient,
      tokenProvider,
      queueRepository: selectedQueue,
      fetchTimeoutMs: config.git.fetchTimeoutMs,
    });
    taskLeaseManager = new TaskLeaseManager({
      identity: agentIdentity,
      trustedIdentities,
      store: taskLeaseStore,
      leaseTtlMs: coordination.leaseTtlMs,
      heartbeatIntervalMs: coordination.heartbeatIntervalMs,
      clockSkewMs: coordination.clockSkewMs,
      allowIdentityTakeover: coordinationExclusive,
    });
  }
  const leaseExecutionContext = taskLeaseManager ? new LeaseExecutionContext({ taskLeaseManager }) : null;
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
    queueRepository: selectedQueue,
    gateController: hardGateController,
  });
  const executionWorkspaceManager = leaseExecutionContext
    ? leaseExecutionContext.wrapWorkspaceManager(gatedWorkspaceManager)
    : gatedWorkspaceManager;
  const planWorkspaceManager = leaseExecutionContext
    ? leaseExecutionContext.wrapWorkspaceManager(workspaceManager)
    : workspaceManager;

  const builtIns = builtInToolProfiles();
  for (const name of Object.keys(builtIns)) {
    if (Object.hasOwn(config.tools, name)) throw new Error(`local tool profile name ${name} is reserved by DevBridge`);
  }
  const deterministicProfileNames = Object.keys(builtIns);
  const tools = { ...config.tools, ...builtIns };

  const faultInjector = new DeterministicFaultInjector(config.execution.faultInjection);
  const runtimeExecution = await createRuntimeExecutionContext({
    config,
    workspaceManager,
    gitClient,
    client,
    toolProfiles: tools,
    protectedValues: secretValues,
    env,
  });
  const repositoryExecution = runtimeExecution.repositoryExecution;
  const workerExchange = new WorkerExchange({ stateDirectory: config.state.directory });
  const processRunner = composeWorkRunner({ mailboxStore: workerExchange, activeExecution: repositoryExecution });
  const leaseProcessRunner = leaseExecutionContext
    ? leaseExecutionContext.wrapProcessRunner(processRunner)
    : processRunner;
  const deterministicProcessRunner = new DeterministicProcessRunner({
    sourceEnv: env,
    faultInjector,
    repositoryExecution,
  });
  const scopedDeterministicProcessRunner = runtimeExecution.scope(deterministicProcessRunner);
  const leaseDeterministicProcessRunner = leaseExecutionContext
    ? leaseExecutionContext.wrapProcessRunner(scopedDeterministicProcessRunner)
    : scopedDeterministicProcessRunner;

  const toolchainRegistry = createCoreToolchainRegistry({ env });
  const operationRegistry = createCoreOperationRegistry({ toolchainRegistry });
  const setupStatusObserver = createSetupStatusObserver({
    configuredSubjectCount: config.github.queueRepositories.length,
    enabled: config.execution.enabled,
    inspectCapability: () => repositoryExecution.inspect(),
  });
  operationRegistry.register('setup.status', createSetupStatusOperation({
    observeSetup: () => setupStatusObserver.observe(),
  }));
  const onboardingConfig = config.execution.toolOnboarding ?? {
    enabled: false,
    manifestDirectory: null,
    autoIntegrate: [],
    maxHelpBytes: 262_144,
    probeTimeoutMs: 15_000,
  };
  const manifestDirectory = await canonicalExternalDirectory(onboardingConfig.manifestDirectory, config.workspace.root);
  const localOperationManifests = manifestDirectory
    ? await loadLocalOperationManifests({ directory: manifestDirectory, registry: operationRegistry })
    : [];
  const toolOnboarding = onboardingConfig.enabled
    ? connectToolOnboarding({
        onboarding: new ToolOnboarding({
          entries: onboardingConfig.autoIntegrate,
          probeTimeoutMs: onboardingConfig.probeTimeoutMs,
          maxHelpBytes: onboardingConfig.maxHelpBytes,
        }),
        directory: manifestDirectory,
        operationRegistry,
        activeExecution: repositoryExecution,
      })
    : null;
  const deterministicControllerPlanExecutor = new ControllerPlanExecutor({
    operationRegistry,
    processRunner: leaseDeterministicProcessRunner,
    workspaceManager: planWorkspaceManager,
    faultInjector,
  });
  const controllerPlanExecutor = new LivenessProjectingPlanExecutor({
    delegate: deterministicControllerPlanExecutor,
    statusReporter,
  });

  toolInventory = new ToolInventoryService({
    operationRegistry,
    toolchainRegistry,
    repositoryExecution,
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
    workspaceManager: executionWorkspaceManager,
    processRunner: leaseProcessRunner,
    controllerPlanExecutor,
    statusReporter,
    feedbackSource,
    queueRepository: selectedQueue,
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
    queueRepository: selectedQueue,
    maxTurns: config.execution.maxTurns,
  });

  return {
    config,
    queueRepository: selectedQueue,
    githubContext: sharedGitHub,
    stateStore,
    chatHandoffStore,
    chatHandoffProjector,
    toolInventory,
    toolInventoryProjector,
    toolOnboarding,
    localOperationManifests,
    contextBudget,
    rateBudget,
    client,
    taskSource,
    feedbackSource,
    decisionSource,
    statusReporter,
    agentIdentity,
    taskLeaseStore,
    taskLeaseManager,
    leaseExecutionContext,
    workspacePolicy,
    gitClient,
    workspaceManager,
    gatedWorkspaceManager,
    processRunner,
    workerExchange,
    deterministicProcessRunner,
    repositoryExecution,
    faultInjector,
    toolchainRegistry,
    operationRegistry,
    controllerPlanExecutor,
    baseCoordinator,
    coordinator,
  };
}
