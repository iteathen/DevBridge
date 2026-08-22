import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspacePolicy } from '../security/workspace-policy.js';
import { validateToolProfile } from '../runtime/cli-profile.js';
import { createCoreToolchainRegistry } from '../runtime/toolchain-registry.js';
import { createCoreOperationRegistry } from '../runtime/deterministic-operation-registry.js';
import { operationSecurityDescription } from '../runtime/deterministic-operation-security.js';
import { ToolInventoryService } from '../runtime/tool-inventory.js';
import { builtInToolProfiles } from '../runtime/builtin-tool-profiles.js';
import { profileSecurityDescription } from '../runtime/profile-security.js';
import { assertRepositoryExecutionContract } from '../runtime/repository-execution.js';
import { DeterministicFaultInjector } from '../runtime/fault-injector.js';
import { GitClient } from '../git/git-client.js';
import {
  inspectRepositoryAdmission,
  normalizeRepositoryAdmissionSet,
} from '../git/repository-admission.js';
import { resolveGitHubCredential, publicGitHubCredentialStatus } from '../github/auth-provider.js';
import { normalizeEnvironmentFoundationStatus } from '../runtime/environment-foundation.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createRepositoryExecution } from './repository-execution.js';

async function describeProfile(name, raw, { source, allowUncontainedTools, repositoryExecutionStatus }) {
  const profile = validateToolProfile(name, raw, { allowUncontainedTools });
  return { name, inputMode: profile.inputMode, layer: 'adapter', source, ...profileSecurityDescription(profile, repositoryExecutionStatus) };
}

function cloneRemote(config, repository) {
  return `${String(config.git.cloneBaseUrl).replace(/\/$/u, '')}/${repository}.git`;
}

export async function doctor(config, {
  resolveTools = true,
  checkGit = true,
  checkGitHubAuth = true,
  checkRepositoryAdmission = false,
  repositoryAdmissionTargets = null,
  probeCoreCapabilities = true,
  env = process.env,
  repositoryExecution = null,
  environmentFoundation = null,
  probeEnvironmentFoundation = null,
  environmentDiagnosis = null,
} = {}) {
  if (probeEnvironmentFoundation != null && typeof probeEnvironmentFoundation !== 'boolean') throw new TypeError('probeEnvironmentFoundation must be boolean or null');
  if (typeof checkRepositoryAdmission !== 'boolean') throw new TypeError('checkRepositoryAdmission must be boolean');
  if (environmentDiagnosis != null && typeof environmentDiagnosis.list !== 'function') throw new TypeError('environmentDiagnosis must expose a read-only list contract');
  const workspace = new WorkspacePolicy(config.workspace);
  const workspaceRoot = await workspace.ensureRoot();
  await mkdir(config.state.directory, { recursive: true, mode: 0o700 });

  const toolchainRegistry = createCoreToolchainRegistry({ env });
  const operationRegistry = createCoreOperationRegistry({ toolchainRegistry });
  const execution = repositoryExecution == null
    ? await createRepositoryExecution({
        stateDirectory: config.state.directory,
        env,
        rootFor: async () => { throw new Error('doctor inspection does not open an execution source'); },
        listPaths: async () => { throw new Error('doctor inspection does not enumerate execution source'); },
        resolveSubject: async () => { throw new Error('doctor inspection does not resolve an execution subject'); },
        resolveTool: async () => { throw new Error('doctor inspection does not resolve an execution tool'); },
      })
    : assertRepositoryExecutionContract(repositoryExecution);
  const repositoryExecutionStatus = execution.inspect();
  const shouldProbeEnvironmentFoundation = probeEnvironmentFoundation ?? probeCoreCapabilities;
  let environmentFoundationStatus = null;
  if (environmentFoundation != null) environmentFoundationStatus = normalizeEnvironmentFoundationStatus(await environmentFoundation.inspect());
  else if (shouldProbeEnvironmentFoundation) {
    const foundation = await createEnvironmentFoundation({ stateDirectory: config.state.directory });
    environmentFoundationStatus = normalizeEnvironmentFoundationStatus(await foundation.inspect());
  }
  const environmentDiagnostics = environmentDiagnosis == null ? null : await environmentDiagnosis.list();
  if (environmentDiagnostics != null && !Array.isArray(environmentDiagnostics)) throw new TypeError('environment diagnosis list must be an array');

  const builtIns = builtInToolProfiles();
  for (const name of Object.keys(builtIns)) if (Object.hasOwn(config.tools, name)) throw new Error(`local tool profile name ${name} is reserved by DevBridge`);

  const tools = [];
  for (const [name, raw] of Object.entries(config.tools)) {
    tools.push(await describeProfile(name, raw, { source: 'local-profile', allowUncontainedTools: config.execution.allowUncontainedTools, repositoryExecutionStatus }));
  }
  const builtInTools = [];
  for (const [name, raw] of Object.entries(builtIns)) {
    builtInTools.push(await describeProfile(name, raw, { source: 'devbridge-builtin', allowUncontainedTools: false, repositoryExecutionStatus }));
  }

  if (config.execution.enabled && !config.execution.controllerPlansEnabled && tools.length === 0) {
    throw new Error('execution.enabled is true but neither controller plans nor valid local tool profiles are enabled');
  }
  if (config.execution.defaultTool && !Object.hasOwn(config.tools, config.execution.defaultTool) && !Object.hasOwn(builtIns, config.execution.defaultTool)) {
    throw new Error(`execution.defaultTool does not exist: ${config.execution.defaultTool}`);
  }

  const operations = operationRegistry.describe().map((entry) => ({ ...entry, ...operationSecurityDescription(entry.name, repositoryExecutionStatus) }));
  const toolchains = probeCoreCapabilities ? await toolchainRegistry.inspect() : toolchainRegistry.names().map((name) => ({ name, available: null, layer: 'core' }));
  const faultInjection = new DeterministicFaultInjector(config.execution.faultInjection ?? {}).inspect();
  let toolInventory = null;
  if (probeCoreCapabilities) {
    toolInventory = await new ToolInventoryService({
      operationRegistry, toolchainRegistry, repositoryExecution: execution,
      profiles: { ...config.tools, ...builtIns }, deterministicProfileNames: Object.keys(builtIns),
      modelAdaptersEnabled: config.execution.modelAdaptersEnabled, allowUncontainedTools: config.execution.allowUncontainedTools,
      env, runtimeIdentity: { version: '0.1.0' },
    }).refresh();
  }

  const needsGitClient = checkGit || checkRepositoryAdmission;
  const gitClient = needsGitClient
    ? new GitClient({ executable: config.git.executable, syntheticHome: path.join(config.state.directory, 'git-home') })
    : null;
  let gitVersion = null;
  if (checkGit) gitVersion = await gitClient.version();

  let githubAuth = publicGitHubCredentialStatus(config.github.auth, null);
  let credential = null;
  if (checkGitHubAuth || checkRepositoryAdmission) {
    credential = await resolveGitHubCredential(config.github.auth, { env });
    githubAuth = publicGitHubCredentialStatus(config.github.auth, credential);
    if (checkGitHubAuth && config.execution.enabled && !githubAuth.available) {
      throw new Error('GitHub authentication is required when execution is enabled. ' +
        `Checked environment variables: ${githubAuth.environmentVariables.join(', ')}; ` +
        `GitHub CLI fallback: ${githubAuth.githubCliExecutable} auth token --hostname ${githubAuth.hostname}. ` +
        'Set one of the environment variables or authenticate GitHub CLI locally.');
    }
  }

  let repositoryAdmission = [];
  if (checkRepositoryAdmission) {
    const targets = normalizeRepositoryAdmissionSet(repositoryAdmissionTargets ?? [config.github.queueRepository]);
    repositoryAdmission = await Promise.all(targets.map((repository) => inspectRepositoryAdmission({
      repository,
      remoteUrl: cloneRemote(config, repository),
      token: credential?.token ?? null,
      timeoutMs: config.git.fetchTimeoutMs,
      run: (args, options) => gitClient.run(args, options),
    })));
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
      repositoryExecution: repositoryExecutionStatus,
      environmentFoundation: environmentFoundationStatus,
      environmentDiagnostics,
      repositoryAdmission,
      core: {
        controllerPlans: { enabled: config.execution.controllerPlansEnabled, repositoryExecution: repositoryExecutionStatus, operations },
        toolchains,
        faultInjection,
      },
      adapters: { enabled: config.execution.modelAdaptersEnabled, repositoryExecution: repositoryExecutionStatus, tools, builtIns: builtInTools },
    },
    tools,
  };
}
