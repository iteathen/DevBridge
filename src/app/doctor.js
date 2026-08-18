import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspacePolicy } from '../security/workspace-policy.js';
import { validateToolProfile } from '../runtime/cli-profile.js';
import { resolveExecutable } from '../runtime/executable-resolver.js';
import { builtInToolProfiles } from '../runtime/builtin-tool-profiles.js';
import { createSandboxManager } from '../runtime/sandbox-manager.js';
import { ToolInventoryService } from '../runtime/tool-inventory-service.js';
import { createCoreToolchainRegistry } from '../runtime/toolchain-registry.js';
import { createCoreOperationRegistry } from '../runtime/deterministic-operation-registry.js';
import { DeterministicFaultInjector } from '../runtime/fault-injector.js';
import { GitClient } from '../git/git-client.js';
import { resolveGitHubCredential, publicGitHubCredentialStatus } from '../github/auth-provider.js';

export async function doctor(
  config,
  {
    resolveTools = true,
    checkGit = true,
    checkGitHubAuth = true,
    probeCoreCapabilities = true,
    env = process.env,
  } = {},
) {
  const workspace = new WorkspacePolicy(config.workspace);
  const workspaceRoot = await workspace.ensureRoot();
  await mkdir(config.state.directory, { recursive: true, mode: 0o700 });

  const builtIns = builtInToolProfiles();
  for (const name of Object.keys(builtIns)) {
    if (Object.hasOwn(config.tools, name)) throw new Error(`local tool profile name ${name} is reserved by PATCH-POLLER`);
  }
  const allTools = { ...config.tools, ...builtIns };
  const deterministicProfileNames = Object.keys(builtIns);
  const tools = [];
  for (const [name, raw] of Object.entries(allTools)) {
    const profile = validateToolProfile(name, raw, {
      allowUncontainedTools: config.execution.allowUncontainedTools,
      allowControlOwnedTools: deterministicProfileNames.includes(name),
    });
    let available = null;
    if (resolveTools) {
      try {
        await resolveExecutable(profile.executable, env);
        available = true;
      } catch {
        available = false;
      }
    }
    tools.push({
      name,
      available,
      inputMode: profile.inputMode,
      layer: profile.controlOwned ? 'control-diagnostic' : 'adapter',
      enabled: profile.controlOwned || config.execution.modelAdaptersEnabled,
      declaredSandbox: profile.sandbox,
      controlOwned: profile.controlOwned,
    });
  }

  if (config.execution.enabled && !config.execution.controllerPlansEnabled && tools.filter((tool) => tool.layer === 'adapter').length === 0) {
    throw new Error('execution.enabled is true but neither controller plans nor valid local tool profiles are enabled');
  }
  if (config.execution.defaultTool && !Object.hasOwn(config.tools, config.execution.defaultTool)) {
    throw new Error(`execution.defaultTool does not exist: ${config.execution.defaultTool}`);
  }

  const sandboxManager = createSandboxManager(config.execution.sandbox, {
    env,
    allowUnsafeUncontained: config.execution.allowUncontainedTools,
  });
  const sandbox = await sandboxManager.inspect({ refresh: true });
  const toolchainRegistry = createCoreToolchainRegistry({ env });
  const operationRegistry = createCoreOperationRegistry({ toolchainRegistry });
  const toolchains = probeCoreCapabilities
    ? await toolchainRegistry.inspect({ refresh: true })
    : toolchainRegistry.names().map((name) => ({ name, available: null, layer: 'core', health: 'unprobed' }));
  const faultInjection = new DeterministicFaultInjector(config.execution.faultInjection ?? {}).inspect();
  const toolInventoryService = new ToolInventoryService({
    operationRegistry,
    toolchainRegistry,
    tools: allTools,
    deterministicProfileNames,
    modelAdaptersEnabled: config.execution.modelAdaptersEnabled,
    allowUncontainedTools: config.execution.allowUncontainedTools,
    sandboxManager,
    env,
  });
  const toolInventory = await toolInventoryService.initialize();

  let gitVersion = null;
  if (checkGit) {
    const git = new GitClient({ executable: config.git.executable, syntheticHome: path.join(config.state.directory, 'git-home') });
    gitVersion = await git.version();
  }

  let githubAuth = publicGitHubCredentialStatus(config.github.auth, null);
  if (checkGitHubAuth) {
    const credential = await resolveGitHubCredential(config.github.auth, { env });
    githubAuth = publicGitHubCredentialStatus(config.github.auth, credential);
    if (config.execution.enabled && !githubAuth.available) {
      throw new Error(
        'GitHub authentication is required when execution is enabled. ' +
        `Checked environment variables: ${githubAuth.environmentVariables.join(', ')}; ` +
        `GitHub CLI fallback: ${githubAuth.githubCliExecutable} auth token --hostname ${githubAuth.hostname}. ` +
        'Set one of the environment variables or authenticate GitHub CLI locally.',
      );
    }
  }

  const repositoryCodeOperations = operationRegistry.describe().filter((operation) => operation.executionClass === 'repository-code-executing');
  const sandboxRequired = config.execution.enabled && config.execution.controllerPlansEnabled && repositoryCodeOperations.length > 0;
  const sandboxSatisfied = sandbox.verified === true || config.execution.allowUncontainedTools === true;

  return {
    ok: !sandboxRequired || sandboxSatisfied,
    queueRepository: config.github.queueRepository,
    apiVersion: config.github.apiVersion,
    githubAuth,
    workspaceRoot,
    stateDirectory: path.resolve(config.state.directory),
    executionEnabled: config.execution.enabled,
    executionReady: !sandboxRequired || sandboxSatisfied,
    autoPushTaskBranches: config.publication.autoPushTaskBranches,
    gitVersion,
    decisions: {
      enabled: config.decisions.enabled,
      expiryMs: config.decisions.expiryMs,
      authorityClasses: Object.fromEntries(Object.entries(config.decisions.authorities).map(([name, actorIds]) => [name, actorIds.length])),
    },
    sandbox: {
      configuredProvider: config.execution.sandbox.provider,
      provider: sandbox.provider,
      configured: sandbox.configured,
      available: sandbox.available,
      verified: sandbox.verified,
      reason: sandbox.reason,
      boundaries: sandbox.boundaries,
      checkedAt: sandbox.checkedAt,
    },
    capabilities: {
      core: {
        controllerPlans: {
          enabled: config.execution.controllerPlansEnabled,
          operations: operationRegistry.describe().map((operation) => ({
            ...operation,
            enforcementSatisfied: operation.requiredEnforcement === 'none' || sandbox.verified === true,
          })),
        },
        toolchains,
        faultInjection,
      },
      adapters: {
        enabled: config.execution.modelAdaptersEnabled,
        tools,
      },
    },
    toolInventory,
    tools,
  };
}
