import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigurationError } from './errors.js';

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PREFIX_RE = /^[A-Za-z0-9_.-]+$/;

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
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigurationError(`${name} must be an integer >= ${min}`);
  }
  return value;
}

function requireNumber(value, name, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be a finite number between ${min} and ${max}`);
  }
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

  const rate = requireObject(github.rateLimit ?? {}, 'github.rateLimit');
  const workspace = requireObject(config.workspace, 'workspace');
  const allowedOwners = workspace.allowedOwners;
  if (!Array.isArray(allowedOwners) || allowedOwners.length === 0 || allowedOwners.some((owner) => !/^[A-Za-z0-9_.-]+$/.test(owner))) {
    throw new ConfigurationError('workspace.allowedOwners must contain at least one safe owner name');
  }

  const state = requireObject(config.state ?? {}, 'state');
  const execution = requireObject(config.execution ?? {}, 'execution');
  const status = requireObject(config.status ?? {}, 'status');
  const tools = requireObject(config.tools ?? {}, 'tools');
  const git = requireObject(config.git ?? {}, 'git');
  const publication = requireObject(config.publication ?? {}, 'publication');
  const daemon = requireObject(config.daemon ?? {}, 'daemon');
  const branchPrefix = requireString(publication.branchPrefix ?? 'patchpoller', 'publication.branchPrefix');
  if (!BRANCH_PREFIX_RE.test(branchPrefix)) throw new ConfigurationError('publication.branchPrefix must be a safe branch segment');

  return {
    version: 1,
    github: {
      queueRepository,
      taskLabel: requireString(github.taskLabel ?? 'patch-poller:ready', 'github.taskLabel'),
      trustedActorIds: trustedActorIds.map(String),
      tokenEnv: requireString(github.tokenEnv ?? 'PATCH_POLLER_GITHUB_TOKEN', 'github.tokenEnv'),
      apiVersion: requireString(github.apiVersion ?? '2026-03-10', 'github.apiVersion'),
      pollIntervalMs: requireInteger(github.pollIntervalMs ?? 60_000, 'github.pollIntervalMs', { min: 15_000 }),
      rateLimit: {
        reserveRatio: requireNumber(rate.reserveRatio ?? 0.2, 'github.rateLimit.reserveRatio', { min: 0, max: 0.9 }),
        minimumReserve: requireInteger(rate.minimumReserve ?? 250, 'github.rateLimit.minimumReserve'),
        emergencyReserve: requireInteger(rate.emergencyReserve ?? 25, 'github.rateLimit.emergencyReserve'),
        mutationIntervalMs: requireInteger(rate.mutationIntervalMs ?? 1100, 'github.rateLimit.mutationIntervalMs', { min: 1000 })
      }
    },
    workspace: {
      root: absolutePath(workspace.root, 'workspace.root'),
      allowCreate: workspace.allowCreate === true,
      allowedOwners: allowedOwners.map((owner) => owner.toLowerCase()),
      externalReadRoots: Array.isArray(workspace.externalReadRoots)
        ? workspace.externalReadRoots.map((entry, index) => absolutePath(entry, `workspace.externalReadRoots[${index}]`))
        : []
    },
    state: { directory: absolutePath(state.directory ?? '~/.patch-poller/state', 'state.directory') },
    git: {
      executable: requireString(git.executable ?? 'git', 'git.executable'),
      cloneBaseUrl: requireString(git.cloneBaseUrl ?? 'https://github.com', 'git.cloneBaseUrl').replace(/\/$/, ''),
      commandTimeoutMs: requireInteger(git.commandTimeoutMs ?? 120_000, 'git.commandTimeoutMs', { min: 5_000 }),
      fetchTimeoutMs: requireInteger(git.fetchTimeoutMs ?? 300_000, 'git.fetchTimeoutMs', { min: 5_000 })
    },
    execution: {
      enabled: execution.enabled === true,
      defaultTool: execution.defaultTool == null ? null : requireString(execution.defaultTool, 'execution.defaultTool'),
      maxConcurrentTasks: requireInteger(execution.maxConcurrentTasks ?? 1, 'execution.maxConcurrentTasks', { min: 1 }),
      maxTurns: requireInteger(execution.maxTurns ?? 8, 'execution.maxTurns', { min: 1 }),
      allowUncontainedTools: execution.allowUncontainedTools === true
    },
    publication: {
      autoPushTaskBranches: publication.autoPushTaskBranches === true,
      branchPrefix
    },
    daemon: {
      errorBackoffMs: requireInteger(daemon.errorBackoffMs ?? 60_000, 'daemon.errorBackoffMs', { min: 5_000 })
    },
    status: {
      progressIntervalMs: requireInteger(status.progressIntervalMs ?? 300_000, 'status.progressIntervalMs', { min: 30_000 }),
      maxCommentBytes: requireInteger(status.maxCommentBytes ?? 48_000, 'status.maxCommentBytes', { min: 4_096 })
    },
    tools
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
