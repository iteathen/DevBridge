import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspacePolicy } from '../security/workspace-policy.js';
import { validateToolProfile } from '../runtime/cli-profile.js';
import { resolveExecutable } from '../runtime/executable-resolver.js';
import { createCoreToolchainRegistry } from '../runtime/toolchain-registry.js';
import { createCoreOperationRegistry } from '../runtime/deterministic-operation-registry.js';
import { createDeterministicSandboxProvider } from '../runtime/deterministic-sandbox.js';
import { operationSecurityDescription } from '../runtime/deterministic-operation-security.js';
import { ToolInventoryService } from '../runtime/tool-inventory.js';
import { builtInToolProfiles } from '../runtime/builtin-tool-profiles.js';
import { enforcementProviderReport, profileSecurityDescription } from '../runtime/profile-security.js';
import { DeterministicFaultInjector } from '../runtime/fault-injector.js';
import { GitClient } from '../git/git-client.js';
import { resolveGitHubCredential, publicGitHubCredentialStatus } from '../github/auth-provider.js';

async function describeProfile(name, raw, {
  source,
  allowUncontainedTools,
  resolveTools,
  env,
  enforcementProvider,
}) {
  const profile = validateToolProfile(name, raw, { allowUncontainedTools });
  const executable = resolveTools ? await resolveExecutable(profile.executable, env) : profile.executable;
  return {
    name,
    executable,
    inputMode: profile.inputMode,
    layer: 'adapter',
    source,
    ...profileSecurityDescription(profile, enforcementProvider),
  };
}

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

  const toolchainRegistry = createCoreToolchainRegistry({ env });
  const operationRegistry = createCoreOperationRegistry({ toolchainRegistry });
  const deterministicSandboxProvider = createDeterministicSandboxProvider({
    externalReadRoots: config.workspace.externalReadRoots,
    workspaceRoot: config.workspace.root,
    stateDirectory: config.state.directory,
    env,
  });
  const observedSandbox = probeCoreCapabilities
    ? await deterministicSandboxProvider.verify()
    : deterministicSandboxProvider.inspect();
  const enforcementProvider = enforcementProviderReport(observedSandbox);

  const builtIns = builtInToolProfiles();
  for (const name of Object.keys(builtIns)) {
    if (Object.hasOwn(config.tools, name)) {
      throw new Error(`local tool profile name ${name} is reserved by DevBridge`);
    }
  }

  const tools = [];
  for (const [name, raw] of Object.entries(config.tools)) {
    tools.push(await describeProfile(name, raw, {
      source: 'local-profile',
      allowUncontainedTools: config.execution.allowUncontainedTools,
      resolveTools,
      env,
      enforcementProvider,
    }));
  }
  const builtInTools = [];
  for (const [name, raw] of Object.entries(builtIns)) {
    builtInTools.push(await describeProfile(name, raw, {
      source: 'devbridge-builtin',
      allowUncontainedTools: false,
      resolveTools,
      env,
      enforcementProvider,
    }));
  }

  if (config.execution.enabled && !config.execution.controllerPlansEnabled && tools.length === 0) {
    throw new Error('execution.enabled is true but neither controller plans nor valid local tool profiles are enabled');
  }
  if (config.execution.defaultTool && !Object.hasOwn(config.tools, config.execution.defaultTool) && !Object.hasOwn(builtIns, config.execution.defaultTool)) {
    throw new Error(`execution.defaultTool does not exist: ${config.execution.defaultTool}`);
  }

  const operations = operationRegistry.describe().map((entry) => ({
    ...entry,
    ...operationSecurityDescription(entry.name, enforcementProvider),
  }));
  const toolchains = probeCoreCapabilities
    ? await toolchainRegistry.inspect()
    : toolchainRegistry.names().map((name) => ({ name, available: null, layer: 'core' }));
  const faultInjection = new DeterministicFaultInjector(config.execution.faultInjection ?? {}).inspect();
  let toolInventory = null;
  if (probeCoreCapabilities) {
    const inventoryService = new ToolInventoryService({
      operationRegistry,
      toolchainRegistry,
      sandboxProvider: deterministicSandboxProvider,
      profiles: { ...config.tools, ...builtIns },
      deterministicProfileNames: Object.keys(builtIns),
      modelAdaptersEnabled: config.execution.modelAdaptersEnabled,
      allowUncontainedTools: config.execution.allowUncontainedTools,
      env,
      runtimeIdentity: { version: '0.1.0' },
    });
    toolInventory = await inventoryService.refresh();
  }

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

  return {
    ok: true,
    queueRepository: config.github.queueRepository,
    apiVersion: config.github.apiVersion,
    githubAuth,
    workspaceRoot,
    stateDirectory: path.resolve(config.state.directory),
    executionEnabled: config.execution.enabled,
    autoPushTaskBranches: config.publication.autoPushTaskBranches,
    gitVersion,
    toolInventory,
    capabilities: {
      enforcementProvider,
      core: {
        controllerPlans: {
          enabled: config.execution.controllerPlansEnabled,
          enforcementProvider,
          // Backward-compatible alias. This has always described the observed
          // DevBridge provider, never a profile's sandbox declaration.
          sandbox: enforcementProvider,
          operations,
        },
        toolchains,
        faultInjection,
      },
      adapters: {
        enabled: config.execution.modelAdaptersEnabled,
        enforcementProvider,
        tools,
        builtIns: builtInTools,
      },
    },
    tools,
  };
}
