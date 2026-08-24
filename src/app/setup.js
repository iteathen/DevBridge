import os from 'node:os';
import path from 'node:path';
import { GitHubRestClient } from '../github/rest-client.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { JsonStateStore } from '../state/json-state-store.js';
import { createUbuntuProductionImagePhysicalCanary, UBUNTU_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL } from './ubuntu-production-image-physical-canary.js';
import { discoverGitHubSetupScope } from '../setup/github-discovery.js';
import { installStableDevBridgeCommand } from '../setup/path-installation.js';
import { reconcileSetupPrerequisites } from '../setup/prerequisite-reconciliation.js';
import { selectRepositoryDefaults } from '../setup/repository-defaults.js';
import { createUbuntuSetupAuthority, defaultUbuntuPackageSnapshot } from '../setup/ubuntu-authority.js';
import { establishUbuntuReleaseAuthority } from '../setup/ubuntu-release-authority.js';

const PROTOCOL = 'devbridge/setup-status-v1';
const STATE_KEY = 'setup:v1';
const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_DISK_BYTES = 32 * 1024 * 1024 * 1024;
const DEFAULT_PROCESSORS = 2;

function absoluteHome(value) {
  const selected = value ?? process.env.DEVBRIDGE_HOME ?? path.join(os.homedir(), '.devbridge');
  if (typeof selected !== 'string' || selected.length === 0 || selected.includes('\0')) throw new TypeError('DevBridge setup home is invalid');
  return path.resolve(selected);
}

async function resolveGitHubToken({ env = process.env, invoke = invokeCommand } = {}) {
  const direct = [env.GH_TOKEN, env.GITHUB_TOKEN].find((value) => typeof value === 'string' && value.trim().length > 0);
  if (direct) return direct.trim();
  try {
    const result = await invoke({
      executable: process.platform === 'win32' ? 'gh.exe' : 'gh',
      arguments: ['auth', 'token', '--hostname', 'github.com'],
      input: null,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
    if (result?.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputTruncated) {
      const token = String(result.stdout ?? '').trim();
      if (token.length > 0 && token.length <= 4096 && !token.includes('\0')) return token;
    }
  } catch {
    // Missing gh is a focused authentication blocker below, not a setup crash.
  }
  return null;
}

function setupState(previous, { identity, repositories, snapshot }) {
  return Object.freeze({
    protocol: PROTOCOL,
    identity: Object.freeze({ id: identity.id, login: identity.login }),
    repositories: Object.freeze({ selected: repositories.selected.map((entry) => ({ id: entry.id, fullName: entry.fullName, private: entry.private })) }),
    ubuntu: Object.freeze({ snapshot }),
  });
}

function acceptedRepositorySelection(previous, identity, requestedRepositories) {
  if (requestedRepositories != null || previous?.repositories?.selected == null) return null;
  if (previous.protocol !== PROTOCOL || !Array.isArray(previous.repositories.selected)) {
    throw new Error('persisted repository selection is invalid; use --repository to establish the selection explicitly');
  }
  if (!Number.isSafeInteger(previous?.identity?.id) || previous.identity.id < 1 || typeof previous.identity.login !== 'string') {
    throw new Error('persisted repository authority is invalid; use --repository to establish the selection explicitly');
  }
  if (previous.identity.id !== identity.id) {
    throw new Error(`GitHub setup identity changed from ${previous.identity.login} to ${identity.login}; use --repository to explicitly accept a selection for the current identity`);
  }
  return previous.repositories.selected;
}

function publicResult({ home, pathStatus, repositories = null, identity = null, snapshot = null, prerequisites = null, physical = null, blocker = null }) {
  const readyForConstruction = physical?.blocked === false && physical?.complete !== true && physical?.state === 'absent';
  return Object.freeze({
    protocol: PROTOCOL,
    home,
    phase: blocker ? 'blocked' : readyForConstruction ? 'ready-for-construction' : physical?.complete ? 'image-complete' : physical?.state ?? 'discovering',
    blocked: blocker != null || physical?.blocked === true,
    blocker: blocker ?? physical?.reason ?? null,
    readyForConstruction,
    path: pathStatus,
    github: identity ? Object.freeze({ id: identity.id, login: identity.login }) : null,
    repositories,
    prerequisites,
    linuxProfile: Object.freeze({ profile: 'linux-development', snapshot, physicalStatus: physical }),
  });
}

export function formatSetupHandoff(result) {
  if (!result || result.protocol !== PROTOCOL) throw new TypeError('setup handoff result is invalid');
  if (result.blocked) {
    const lines = ['DevBridge setup is blocked.', '', `Reason: ${result.blocker ?? 'unknown blocker'}`];
    if (result.path?.requiresNewShell) lines.push('', `PATH is persisted; until a new shell is opened use: ${result.path.temporaryCommand}`);
    return `${lines.join('\n')}\n`;
  }
  if (result.readyForConstruction) {
    return [
      'DevBridge setup reached the construction gate.',
      '',
      'Linux execution profile: source/package/payload authority ready',
      `Repositories: ${result.repositories?.selectedCount ?? 0} configured`,
      'Physical image construction: authorized by status gate, not started',
      '',
      'The setup path performed no image or VM construction.',
      result.path?.requiresNewShell ? `Open a new shell for devbridge on PATH. Until then: ${result.path.temporaryCommand}` : 'The devbridge command is available on PATH.',
      '',
    ].join('\n');
  }
  if (result.phase === 'image-complete') {
    return 'Welcome to DevBridge — the Linux production image is already complete.\n';
  }
  return `DevBridge setup state: ${result.phase}\n`;
}

export async function runDevBridgeSetup({
  home = null,
  requestedRepositories = null,
  env = process.env,
} = {}, {
  invoke = invokeCommand,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  platform = process.platform,
  storeFactory = (file) => new JsonStateStore(file),
  pathInstaller = installStableDevBridgeCommand,
  tokenResolver = resolveGitHubToken,
  clientFactory = (token) => new GitHubRestClient({ tokenProvider: async () => token, fetchImpl }),
  discover = discoverGitHubSetupScope,
  selectRepositories = selectRepositoryDefaults,
  prerequisiteReconciler = reconcileSetupPrerequisites,
  releaseAuthority = establishUbuntuReleaseAuthority,
  authorityFactory = createUbuntuSetupAuthority,
  canaryFactory = createUbuntuProductionImagePhysicalCanary,
} = {}) {
  const root = absoluteHome(home);
  const store = storeFactory(path.join(root, 'state', 'setup.json'));
  const previous = await store.get(STATE_KEY);

  let pathStatus;
  try {
    pathStatus = await pathInstaller({
      home: root,
      stage0Launcher: env.DEVBRIDGE_STAGE0_LAUNCHER ?? null,
      platform,
      env,
      invoke,
    });
  } catch (error) {
    return publicResult({ home: root, pathStatus: null, blocker: error.message });
  }

  const token = await tokenResolver({ env, invoke });
  if (!token) return publicResult({ home: root, pathStatus, blocker: 'GitHub authentication is unavailable; authenticate with GitHub CLI or provide GH_TOKEN/GITHUB_TOKEN and re-run devbridge setup' });

  let scope;
  try {
    scope = await discover(clientFactory(token));
  } catch (error) {
    return publicResult({ home: root, pathStatus, blocker: `GitHub discovery failed: ${error.message}` });
  }

  let repositories;
  try {
    const accepted = acceptedRepositorySelection(previous, scope.identity, requestedRepositories);
    repositories = selectRepositories(scope.repositories, { requested: requestedRepositories, accepted });
  } catch (error) {
    return publicResult({ home: root, pathStatus, identity: scope.identity, blocker: error.message });
  }
  if (repositories.needsSelection) {
    return publicResult({ home: root, pathStatus, identity: scope.identity, repositories, blocker: repositories.reason });
  }

  const snapshot = previous?.ubuntu?.snapshot ?? defaultUbuntuPackageSnapshot(now());
  await store.set(STATE_KEY, setupState(previous, { identity: scope.identity, repositories, snapshot }));

  let prerequisites;
  try {
    prerequisites = await prerequisiteReconciler({ platform, invoke, fetchImpl, environment: env });
  } catch (error) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      blocker: `System prerequisite reconciliation failed: ${error.message}`,
    });
  }
  if (prerequisites?.ready !== true) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      blocker: prerequisites?.blocker ?? 'System prerequisites are not ready; resolve the reported host boundary and re-run devbridge setup',
    });
  }
  const signatureVerifierExecutable = prerequisites?.local?.signatureVerifierExecutable ?? null;

  let release;
  let authority;
  try {
    [release, authority] = await Promise.all([
      releaseAuthority({
        home: root,
        fetchImpl,
        invoke,
        signatureVerifierExecutable,
      }),
      authorityFactory({ snapshot, fetchImpl }),
    ]);
  } catch (error) {
    return publicResult({ home: root, pathStatus, identity: scope.identity, repositories, snapshot, prerequisites, blocker: `Ubuntu construction authority is unavailable: ${error.message}` });
  }

  const physicalConfig = Object.freeze({
    protocol: UBUNTU_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL,
    stateDirectory: path.join(root, 'state'),
    keyring: release.keyring,
    authority,
    resources: Object.freeze({ memoryBytes: DEFAULT_MEMORY_BYTES, processorCount: DEFAULT_PROCESSORS, diskBytes: DEFAULT_DISK_BYTES }),
  });

  let physical;
  try {
    const canary = canaryFactory(physicalConfig, { platform, invoke, fetchImpl, signatureVerifierExecutable });
    physical = await canary.status();
  } catch (error) {
    return publicResult({ home: root, pathStatus, identity: scope.identity, repositories, snapshot, prerequisites, blocker: `read-only production-image status gate failed: ${error.message}` });
  }

  return publicResult({ home: root, pathStatus, identity: scope.identity, repositories, snapshot, prerequisites, physical });
}

export { PROTOCOL as SETUP_STATUS_PROTOCOL };
