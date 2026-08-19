import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigurationError } from './errors.js';
import { DEFAULT_GITHUB_TOKEN_ENVIRONMENT_VARIABLES } from './github/auth-provider.js';
import { validateFaultInjectionConfig } from './runtime/fault-injector.js';
import { validateToolOnboardingPolicy } from './runtime/tool-onboarding.js';
import { DECISION_CLASSES } from './run/hard-gate-policy.js';

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PREFIX_RE = /^[A-Za-z0-9_.-]+$/;
const BASELINE_CHANNEL_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const GIT_BRANCH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const ENVIRONMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const GITHUB_AUTH_MODES = new Set(['auto', 'environment', 'github-cli']);
const CONTEXT_BUDGET_UNITS = new Set(['tokens', 'bytes', 'proxy']);
const DECISION_CLASS_SET = new Set(DECISION_CLASSES);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigurationError(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value, name, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min || !Number.isSafeInteger(value)) {
    throw new ConfigurationError(`${name} must be a safe integer >= ${min}`);
  }
  return value;
}

function requireNumber(value, name, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new ConfigurationError(`${name} must be a boolean`);
  return value;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function absolutePath(value, name) {
  const expanded = expandHome(requireString(value, name));
  if (!path.isAbsolute(expanded)) {
    throw new ConfigurationError(`${name} must be an absolute path or start with ~/`);
  }
  return path.normalize(expanded);
}

function requireEnvironmentName(value, name) {
  const result = requireString(value, name);
  if (!ENVIRONMENT_NAME_RE.test(result)) {
    throw new ConfigurationError(`${name} must be a valid environment-variable name`);
  }
  return result;
}

function normalizeGitHubAuth(github) {
  const auth = requireObject(github.auth ?? {}, 'github.auth');
  const mode = requireString(auth.mode ?? 'auto', 'github.auth.mode');
  if (!GITHUB_AUTH_MODES.has(mode)) {
    throw new ConfigurationError('github.auth.mode must be auto, environment, or github-cli');
  }

  let environmentVariables;
  if (auth.environmentVariables != null) {
    if (!Array.isArray(auth.environmentVariables) || auth.environmentVariables.length === 0 ||
        auth.environmentVariables.length > 8) {
      throw new ConfigurationError('github.auth.environmentVariables must contain 1-8 environment-variable names');
    }
    environmentVariables = auth.environmentVariables.map((value, index) =>
      requireEnvironmentName(value, `github.auth.environmentVariables[${index}]`));
  } else {
    const preferred = github.tokenEnv == null
      ? null
      : requireEnvironmentName(github.tokenEnv, 'github.tokenEnv');
    environmentVariables = [
      ...(preferred ? [preferred] : []),
      ...DEFAULT_GITHUB_TOKEN_ENVIRONMENT_VARIABLES,
    ];
  }
  environmentVariables = [...new Set(environmentVariables)];

  const hostname = requireString(auth.hostname ?? 'github.com', 'github.auth.hostname');
  if (!HOSTNAME_RE.test(hostname)) {
    throw new ConfigurationError('github.auth.hostname must be a safe hostname');
  }

  return {
    mode,
    environmentVariables,
    githubCliExecutable: requireString(auth.githubCliExecutable ?? 'gh', 'github.auth.githubCliExecutable'),
    hostname: hostname.toLowerCase(),
  };
}

function normalizeBaselineChannels(workspace) {
  const raw = workspace.baselineChannels ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 16) {
    throw new ConfigurationError('workspace.baselineChannels must be an object with at most 16 local semantic channels');
  }
  const channels = {};
  for (const [channel, branch] of Object.entries(raw)) {
    if (!BASELINE_CHANNEL_RE.test(channel)) throw new ConfigurationError(`workspace.baselineChannels channel ${channel} is invalid`);
    const normalizedBranch = requireString(branch, `workspace.baselineChannels.${channel}`);
    if (!GIT_BRANCH_RE.test(normalizedBranch) || normalizedBranch.includes('..') || normalizedBranch.includes('@{') || normalizedBranch.endsWith('.lock')) {
      throw new ConfigurationError(`workspace.baselineChannels.${channel} must be a safe branch name`);
    }
    channels[channel] = normalizedBranch;
  }
  const defaultChannel = workspace.defaultBaselineChannel == null
    ? null
    : requireString(workspace.defaultBaselineChannel, 'workspace.defaultBaselineChannel');
  if (defaultChannel != null && !Object.hasOwn(channels, defaultChannel)) {
    throw new ConfigurationError('workspace.defaultBaselineChannel must name a configured local baseline channel');
  }
  return { channels, defaultChannel };
}

function normalizeFaultInjection(execution) {
  try {
    return validateFaultInjectionConfig(execution.faultInjection ?? {});
  } catch (error) {
    throw new ConfigurationError(error.message, { cause: error });
  }
}

function normalizeDecisionAuthorities(execution) {
  const raw = requireObject(execution.decisionAuthorities ?? {}, 'execution.decisionAuthorities');
  const authorities = {};
  for (const [decisionClass, actorIds] of Object.entries(raw)) {
    if (!DECISION_CLASS_SET.has(decisionClass)) {
      throw new ConfigurationError(`execution.decisionAuthorities.${decisionClass} is not a supported local decision class`);
    }
    if (!Array.isArray(actorIds) || actorIds.length === 0 || actorIds.length > 32 || actorIds.some((id) => !/^\d+$/u.test(String(id)))) {
      throw new ConfigurationError(`execution.decisionAuthorities.${decisionClass} must contain 1-32 numeric GitHub actor IDs`);
    }
    authorities[decisionClass] = [...new Set(actorIds.map(String))];
  }
  return authorities;
}

function normalizeContextRollover(config) {
  const rollover = requireObject(config.contextRollover ?? {}, 'contextRollover');
  const unit = requireString(rollover.unit ?? 'bytes', 'contextRollover.unit');
  if (!CONTEXT_BUDGET_UNITS.has(unit)) throw new ConfigurationError('contextRollover.unit must be tokens, bytes, or proxy');
  const softRatio = requireNumber(rollover.softRatio ?? 0.55, 'contextRollover.softRatio', { min: Number.EPSILON, max: 0.999999 });
  const preferredRatio = requireNumber(rollover.preferredRatio ?? 0.65, 'contextRollover.preferredRatio', { min: Number.EPSILON, max: 0.999999 });
  const hardRatio = requireNumber(rollover.hardRatio ?? 0.75, 'contextRollover.hardRatio', { min: Number.EPSILON, max: 0.999999 });
  if (!(softRatio < preferredRatio && preferredRatio < hardRatio)) {
    throw new ConfigurationError('contextRollover ratios must satisfy softRatio < preferredRatio < hardRatio');
  }
  const maxHandoffBytes = requireInteger(rollover.maxHandoffBytes ?? 32_768, 'contextRollover.maxHandoffBytes', { min: 4_096 });
  if (maxHandoffBytes > 262_144) throw new ConfigurationError('contextRollover.maxHandoffBytes must be <= 262144');
  const maxRetained = requireInteger(rollover.maxRetained ?? 8, 'contextRollover.maxRetained', { min: 2 });
  if (maxRetained > 64) throw new ConfigurationError('contextRollover.maxRetained must be <= 64');
  return {
    enabled: rollover.enabled == null ? true : requireBoolean(rollover.enabled, 'contextRollover.enabled'),
    unit,
    capacityUnits: requireInteger(rollover.capacityUnits ?? 1_000_000, 'contextRollover.capacityUnits', { min: 1 }),
    softRatio,
    preferredRatio,
    hardRatio,
    maxHandoffBytes,
    maxRetained,
  };
}

function normalizeToolOnboarding(execution) {
  const onboarding = requireObject(execution.toolOnboarding ?? {}, 'execution.toolOnboarding');
  for (const key of Object.keys(onboarding)) {
    if (!['enabled', 'manifestDirectory', 'autoIntegrate', 'maxHelpBytes', 'probeTimeoutMs'].includes(key)) {
      throw new ConfigurationError(`execution.toolOnboarding.${key} is not supported`);
    }
  }
  const enabled = onboarding.enabled == null ? false : requireBoolean(onboarding.enabled, 'execution.toolOnboarding.enabled');
  const manifestDirectory = onboarding.manifestDirectory == null
    ? null
    : absolutePath(onboarding.manifestDirectory, 'execution.toolOnboarding.manifestDirectory');
  let autoIntegrate;
  try {
    autoIntegrate = validateToolOnboardingPolicy({ autoIntegrate: onboarding.autoIntegrate ?? [] });
  } catch (error) {
    throw new ConfigurationError(error.message, { cause: error });
  }
  if (enabled && manifestDirectory == null) {
    throw new ConfigurationError('execution.toolOnboarding.manifestDirectory is required when automatic onboarding is enabled');
  }
  const maxHelpBytes = requireInteger(onboarding.maxHelpBytes ?? 262_144, 'execution.toolOnboarding.maxHelpBytes', { min: 4_096 });
  if (maxHelpBytes > 262_144) throw new ConfigurationError('execution.toolOnboarding.maxHelpBytes must be <= 262144');
  const probeTimeoutMs = requireInteger(onboarding.probeTimeoutMs ?? 15_000, 'execution.toolOnboarding.probeTimeoutMs', { min: 1_000 });
  if (probeTimeoutMs > 60_000) throw new ConfigurationError('execution.toolOnboarding.probeTimeoutMs must be <= 60000');
  return { enabled, manifestDirectory, autoIntegrate, maxHelpBytes, probeTimeoutMs };
}

export function validateConfig(raw) {
  const config = requireObject(raw, 'config');
  if (config.version !== 1) throw new ConfigurationError('config.version must be 1');

  const github = requireObject(config.github, 'github');
  const queueRepository = requireString(github.queueRepository, 'github.queueRepository');
  if (!REPOSITORY_RE.test(queueRepository)) throw new ConfigurationError('github.queueRepository must be owner/name');

  const trustedActorIds = github.trustedActorIds;
  if (!Array.isArray(trustedActorIds) || trustedActorIds.length === 0 || trustedActorIds.some((id) => !/^\d+$/.test(String(id)))) {
    throw new ConfigurationError('github.trustedActorIds must contain at least one numeric GitHub user ID');
  }

  const githubAuth = normalizeGitHubAuth(github);
  const rate = requireObject(github.rateLimit ?? {}, 'github.rateLimit');
  const workspace = requireObject(config.workspace, 'workspace');
  const allowedOwners = workspace.allowedOwners;
  if (!Array.isArray(allowedOwners) || allowedOwners.length === 0 || allowedOwners.some((owner) => !/^[A-Za-z0-9_.-]+$/.test(owner))) {
    throw new ConfigurationError('workspace.allowedOwners must contain at least one safe owner name');
  }
  const baselines = normalizeBaselineChannels(workspace);

  const state = requireObject(config.state ?? {}, 'state');
  const execution = requireObject(config.execution ?? {}, 'execution');
  const status = requireObject(config.status ?? {}, 'status');
  const tools = requireObject(config.tools ?? {}, 'tools');
  const git = requireObject(config.git ?? {}, 'git');
  const publication = requireObject(config.publication ?? {}, 'publication');
  const daemon = requireObject(config.daemon ?? {}, 'daemon');
  const contextRollover = normalizeContextRollover(config);
  const toolOnboarding = normalizeToolOnboarding(execution);
  const branchPrefix = requireString(publication.branchPrefix ?? 'patchpoller', 'publication.branchPrefix');
  if (!BRANCH_PREFIX_RE.test(branchPrefix)) throw new ConfigurationError('publication.branchPrefix must be a safe branch segment');
  const faultInjection = normalizeFaultInjection(execution);
  const decisionAuthorities = normalizeDecisionAuthorities(execution);
  const decisionApprovalTtlMs = requireInteger(execution.decisionApprovalTtlMs ?? 86_400_000, 'execution.decisionApprovalTtlMs', { min: 60_000 });
  if (decisionApprovalTtlMs > 2_592_000_000) throw new ConfigurationError('execution.decisionApprovalTtlMs must be <= 2592000000');
  const architectureGateFileThreshold = requireInteger(execution.architectureGateFileThreshold ?? 20, 'execution.architectureGateFileThreshold', { min: 2 });
  const architectureGateOwnerThreshold = requireInteger(execution.architectureGateOwnerThreshold ?? 4, 'execution.architectureGateOwnerThreshold', { min: 2 });

  return {
    version: 1,
    github: {
      queueRepository,
      taskLabel: requireString(github.taskLabel ?? 'patch-poller:ready', 'github.taskLabel'),
      trustedActorIds: trustedActorIds.map(String),
      tokenEnv: githubAuth.environmentVariables[0],
      auth: githubAuth,
      apiVersion: requireString(github.apiVersion ?? '2026-03-10', 'github.apiVersion'),
      pollIntervalMs: requireInteger(github.pollIntervalMs ?? 60_000, 'github.pollIntervalMs', { min: 15_000 }),
      rateLimit: {
        reserveRatio: requireNumber(rate.reserveRatio ?? 0.2, 'github.rateLimit.reserveRatio', { min: 0, max: 0.9 }),
        minimumReserve: requireInteger(rate.minimumReserve ?? 250, 'github.rateLimit.minimumReserve'),
        emergencyReserve: requireInteger(rate.emergencyReserve ?? 25, 'github.rateLimit.emergencyReserve'),
        mutationIntervalMs: requireInteger(rate.mutationIntervalMs ?? 1100, 'github.rateLimit.mutationIntervalMs', { min: 1000 }),
      },
    },
    workspace: {
      root: absolutePath(workspace.root, 'workspace.root'),
      allowCreate: workspace.allowCreate === true,
      allowedOwners: allowedOwners.map((owner) => owner.toLowerCase()),
      externalReadRoots: Array.isArray(workspace.externalReadRoots)
        ? workspace.externalReadRoots.map((entry, index) => absolutePath(entry, `workspace.externalReadRoots[${index}]`))
        : [],
      baselineChannels: baselines.channels,
      defaultBaselineChannel: baselines.defaultChannel,
    },
    state: { directory: absolutePath(state.directory ?? '~/.patch-poller/state', 'state.directory') },
    contextRollover,
    git: {
      executable: requireString(git.executable ?? 'git', 'git.executable'),
      cloneBaseUrl: requireString(git.cloneBaseUrl ?? 'https://github.com', 'git.cloneBaseUrl').replace(/\/$/, ''),
      commandTimeoutMs: requireInteger(git.commandTimeoutMs ?? 120_000, 'git.commandTimeoutMs', { min: 5_000 }),
      fetchTimeoutMs: requireInteger(git.fetchTimeoutMs ?? 300_000, 'git.fetchTimeoutMs', { min: 5_000 }),
    },
    execution: {
      enabled: execution.enabled === true,
      controllerPlansEnabled: execution.controllerPlansEnabled !== false,
      modelAdaptersEnabled: execution.modelAdaptersEnabled === true,
      defaultTool: execution.defaultTool == null ? null : requireString(execution.defaultTool, 'execution.defaultTool'),
      maxConcurrentTasks: requireInteger(execution.maxConcurrentTasks ?? 1, 'execution.maxConcurrentTasks', { min: 1 }),
      maxTurns: requireInteger(execution.maxTurns ?? 8, 'execution.maxTurns', { min: 1 }),
      allowUncontainedTools: execution.allowUncontainedTools === true,
      toolOnboarding,
      decisionAuthorities,
      decisionApprovalTtlMs,
      architectureGateFileThreshold,
      architectureGateOwnerThreshold,
      faultInjection,
    },
    publication: {
      autoPushTaskBranches: publication.autoPushTaskBranches === true,
      forceNoOpPublication: publication.forceNoOpPublication === true,
      branchPrefix,
    },
    daemon: {
      errorBackoffMs: requireInteger(daemon.errorBackoffMs ?? 60_000, 'daemon.errorBackoffMs', { min: 5_000 }),
    },
    status: {
      progressIntervalMs: requireInteger(status.progressIntervalMs ?? 300_000, 'status.progressIntervalMs', { min: 30_000 }),
      maxCommentBytes: requireInteger(status.maxCommentBytes ?? 48_000, 'status.maxCommentBytes', { min: 4_096 }),
    },
    tools,
  };
}

export async function loadConfig(filePath) {
  const text = await readFile(filePath, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigurationError(`invalid JSON in ${filePath}`, { cause: error });
  }
  return validateConfig(raw);
}