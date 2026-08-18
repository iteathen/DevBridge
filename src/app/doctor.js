import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspacePolicy } from '../security/workspace-policy.js';
import { validateToolProfile } from '../runtime/cli-profile.js';
import { resolveExecutable } from '../runtime/executable-resolver.js';
import { createCoreToolchainRegistry } from '../runtime/toolchain-registry.js';
import { createCoreOperationRegistry } from '../runtime/deterministic-operation-registry.js';
import { verifySandboxProvider } from '../runtime/execution-sandbox.js';
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
    sandboxProvider = null,
    env = process.env,
  } = {},
) {
  const workspace = new WorkspacePolicy(config.workspace);
  const workspaceRoot = await workspace.ensureRoot();
  await mkdir(config.state.directory, { recursive: true, mode: 0o700 });

  const enforcement = await verifySandboxProvider(sandboxProvider);
  const tools = [];
  for (const [name, raw] of Object.entries(config.tools)) {
    const profile = validateToolProfile(name, raw, { allowUncontainedTools: config.execution.allowUncontainedTools });
    let available = null;
    if (resolveTools) {
      await resolveExecutable(profile.executable);
      available = true;
    }
    tools.push({
      name,
      available,
      declaredSandbox: profile.sandbox,
      enforcement: { ...enforcement },
      inputMode: profile.inputMode,
      layer: 'adapter',
    });
  }

  if (config.execution.enabled && !config.execution.controllerPlansEnabled && tools.length === 0) {
    throw new Error('execution.enabled is true but neither controller plans nor valid local tool profiles are enabled');
  }
  if (config.execution.defaultTool && !Object.hasOwn(config.tools, config.execution.defaultTool)) {
    throw new Error(`execution.defaultTool does not exist: ${config.execution.defaultTool}`);
  }

  const toolchainRegistry = createCoreToolchainRegistry({ env });
  const operationRegistry = createCoreOperationRegistry({ toolchainRegistry });
  const toolchains = probeCoreCapabilities
    ? await toolchainRegistry.inspect()
    : toolchainRegistry.names().map((name) => ({ name, available: null, layer: 'core' }));
  const faultInjection = new DeterministicFaultInjector(config.execution.faultInjection ?? {}).inspect();

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
    enforcement: {
      requestedPolicy: {
        repositoryCode: 'verified-sandbox-required',
        network: 'deny-by-default',
        outsideProjectWrite: false,
      },
      provider: enforcement,
    },
    capabilities: {
      core: {
        controllerPlans: {
          enabled: config.execution.controllerPlansEnabled,
          operations: operationRegistry.describe({ enforcementStatus: enforcement }),
        },
        toolchains,
        faultInjection,
      },
      adapters: {
        enabled: config.execution.modelAdaptersEnabled,
        tools,
      },
    },
    tools,
  };
}
