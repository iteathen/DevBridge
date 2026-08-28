import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../config.js';
import { GitHubRestClient } from '../github/rest-client.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { JsonStateStore } from '../state/json-state-store.js';
import { createSetupResourceConflictConsentStore } from '../state/setup-resource-conflict-consent-store.js';
import { createConfiguredLifecycleAuthorityClient } from '../runtime/environment-lifecycle-authority-transport.js';
import { readLocalIdentity } from '../runtime/local-identity.js';
import { createUbuntuProductionImagePhysicalCanary, UBUNTU_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL } from './ubuntu-production-image-physical-canary.js';
import { reconcileSetupEnvironmentActivation } from './setup-environment-activation.js';
import { createSetupEnvironmentProfileConfiguration } from './setup-environment-profile-configuration.js';
import { discoverGitHubSetupScope } from '../setup/github-discovery.js';
import { installStableDevBridgeCommand } from '../setup/path-installation.js';
import { reconcileSetupPrerequisites } from '../setup/prerequisite-reconciliation.js';
import { selectRepositoryDefaults } from '../setup/repository-defaults.js';
import { createUbuntuSetupAuthority, defaultUbuntuPackageSnapshot, UBUNTU_SETUP_OUTPUT } from '../setup/ubuntu-authority.js';
import { establishUbuntuReleaseAuthority } from '../setup/ubuntu-release-authority.js';
import { requestWindowsLifecycleAuthorityElevation } from '../setup/windows-lifecycle-authority-elevation.js';
import { reconcileWindowsLifecycleAuthorityReadiness } from '../setup/windows-lifecycle-authority-readiness.js';
import { createWindowsEnvironmentProfileConfiguration } from '../setup/windows-environment-profile-configuration.js';
import {
  assertSetupResourceConflictPort,
  createClearSetupResourceConflictPort,
  normalizeSetupResourceConflictObservation,
  setupResourceConflictConsent,
} from '../setup/resource-conflict.js';
import { createWindowsSetupResourceConflict } from '../setup/windows-resource-conflict.js';
import {
  createSetupOperationalConfiguration,
  SETUP_OPERATIONAL_CONFIGURATION_REQUEST_PROTOCOL,
} from '../setup/operational-configuration.js';
import { reconcileWindowsInstallMediaSetup } from './windows-install-media-setup.js';

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

function publicLifecycleAuthority(value) {
  if (!value) return null;
  return Object.freeze({
    ready: value.ready === true,
    changed: value.changed === true,
    service: typeof value.service === 'string' ? value.service : 'unknown',
    protectedState: typeof value.protectedState === 'string' ? value.protectedState : 'unknown',
  });
}

function publicEnvironmentActivation(value) {
  if (!value) return null;
  return Object.freeze({
    ready: value.ready === true,
    changed: value.changed === true,
    state: typeof value.state === 'string' ? value.state : 'unknown',
    environmentCount: Number.isSafeInteger(value.environmentCount) ? value.environmentCount : 0,
  });
}

function publicResourceConflict(value) {
  if (!value) return null;
  const observed = normalizeSetupResourceConflictObservation(value);
  return Object.freeze({ state: observed.state, subject: observed.subject, reason: observed.reason });
}

function publicOperationalConfiguration(value) {
  if (!value) return null;
  return Object.freeze({
    ready: value.ready === true,
    changed: value.changed === true,
    executionEnabled: value.executionEnabled === true,
  });
}

async function createSetupResourceConflict({ stateDirectory, platform, invoke }) {
  if (platform !== 'win32') return createClearSetupResourceConflictPort();
  const identity = await readLocalIdentity({ directory: path.join(path.resolve(stateDirectory), 'environment-foundation') });
  if (identity == null) throw new Error('accepted environment foundation identity is unavailable');
  return createWindowsSetupResourceConflict({ identity, platform, invoke });
}

function setupResult({ home, pathStatus, repositories = null, identity = null, snapshot = null, prerequisites = null, lifecycleAuthority = null, physical = null, resourceConflict = null, environmentActivation = null, operationalConfiguration = null, windowsMedia = null, blocker = null, constructionRequested = false, constructionAttempted = false }) {
  const readyForConstruction = constructionAttempted !== true && physical?.blocked === false && physical?.complete !== true;
  return Object.freeze({
    protocol: PROTOCOL,
    home,
    phase: blocker ? 'blocked' : operationalConfiguration?.ready === true ? 'operational-ready' : environmentActivation?.ready === true ? 'environment-ready' : readyForConstruction ? 'ready-for-construction' : physical?.complete ? 'image-complete' : physical?.state ?? 'discovering',
    blocked: blocker != null || physical?.blocked === true,
    blocker: blocker ?? physical?.reason ?? null,
    readyForConstruction,
    construction: Object.freeze({ requested: constructionRequested, attempted: constructionAttempted }),
    path: pathStatus,
    github: identity ? Object.freeze({ id: identity.id, login: identity.login }) : null,
    repositories,
    prerequisites,
    resourceConflict: publicResourceConflict(resourceConflict),
    lifecycleAuthority: publicLifecycleAuthority(lifecycleAuthority),
    environment: publicEnvironmentActivation(environmentActivation),
    operational: publicOperationalConfiguration(operationalConfiguration),
    linuxProfile: Object.freeze({ profile: 'linux-development', snapshot, physicalStatus: physical }),
    windowsProfile: Object.freeze({ profile: 'windows-development', media: windowsMedia }),
  });
}

function appendConstructionLiveness(lines, physical) {
  const liveness = physical?.liveness;
  if (!liveness) return;
  lines.push(
    `Installer liveness: ${liveness.classification}`,
    `Elapsed: ${Math.floor(liveness.elapsedMilliseconds / 60_000)} minute(s)`,
    `Last progress: ${liveness.lastProgressAt} (${Math.floor(liveness.noProgressMilliseconds / 60_000)} minute(s) without observed progress)`,
    `VHDX allocation: ${liveness.diskAllocatedBytes} byte(s); latest observed growth: ${liveness.diskGrowthBytes} byte(s)`,
    `Hyper-V CPU usage: ${liveness.cpuUsagePercent}%`,
    `Hyper-V status: ${liveness.providerStatus}`,
    `Expected completion: ${liveness.expectedCompletionAt}`,
    `Hard deadline: ${liveness.hardDeadlineAt}`,
  );
  if (liveness.nextObservationAt) lines.push(`Next bounded observation: ${liveness.nextObservationAt}`);
}

function appendConstructionReadiness(lines, physical) {
  const readiness = physical?.readiness;
  if (!readiness) return;
  lines.push(
    `Readiness window: ${readiness.classification}`,
    `Elapsed: ${Math.floor(readiness.elapsedMilliseconds / 1000)} second(s)`,
    `Expected frontier: ${readiness.expectedAt}`,
    `Hard deadline: ${readiness.hardDeadlineAt}`,
  );
  if (readiness.nextObservationAt) lines.push(`Next bounded observation: ${readiness.nextObservationAt}`);
}

function appendConstructionDiagnostics(lines, physical) {
  const diagnostics = physical?.diagnostics;
  if (!diagnostics) return;
  if (diagnostics.available !== true) {
    lines.push(`Installer console evidence: unavailable (${diagnostics.reason ?? 'unknown reason'})`);
    return;
  }
  lines.push(
    `Installer console evidence: ${diagnostics.location}`,
    `Installer console SHA-256: ${diagnostics.sha256}`,
    `Installer console captured: ${diagnostics.capturedAt}`,
  );
}

function appendWindowsMedia(lines, windowsProfile) {
  const media = windowsProfile?.media;
  if (!media || media.state === 'platform-unavailable') return;
  lines.push('', 'Windows execution profile media:');
  if (media.state === 'blocked') {
    lines.push(`Blocked: ${media.blocker ?? 'local media reconciliation failed'}`);
    return;
  }
  if (media.state === 'accepted') {
    lines.push(
      `Accepted source class: ${media.accepted.sourceClass}${media.accepted.temporary ? ' (temporary)' : ''}`,
      `Authority subject: ${media.accepted.authority}`,
      `Media: ${media.accepted.media.name} (${media.accepted.media.sha256})`,
      `Image: index ${media.accepted.image.index}, ${media.accepted.image.name}, ${media.accepted.image.architecture}, build ${media.accepted.image.build}`,
    );
    return;
  }
  if (media.state === 'selection-required') {
    for (const candidate of media.candidates) {
      lines.push(`Candidate: ${candidate.subject}`, `Media: ${candidate.media.name} (${candidate.media.sha256})`);
      for (const image of candidate.images) {
        lines.push(
          `  Image ${image.index}: ${image.name}, ${image.architecture}, build ${image.build}`,
          `  Approve owned media: devbridge setup --approve-windows-media ${candidate.subject} --windows-image-index ${image.index} --windows-media-class official-owned`,
        );
      }
    }
    lines.push(`Evaluation media must be explicitly classified with --windows-media-class evaluation and is temporary: ${media.acquisition.evaluation}`);
    if (media.rejectedCount > 0) lines.push(`Rejected media candidates: ${media.rejectedCount}`);
    return;
  }
  if (media.state === 'source-required') {
    if (media.inbox) lines.push(`Managed media inbox: ${media.inbox}`);
    lines.push(
      'Place an owned Windows ISO in the managed inbox, or provide one explicitly:',
      'devbridge setup --windows-media "<absolute-iso-path>"',
      `Official Windows media: ${media.acquisition.officialOwned}`,
      `Optional 90-day Evaluation media (explicit temporary classification required): ${media.acquisition.evaluation}`,
    );
    if (media.rejectedCount > 0) lines.push(`Rejected media candidates: ${media.rejectedCount}`);
  }
}

export function formatSetupHandoff(result) {
  if (!result || result.protocol !== PROTOCOL) throw new TypeError('setup handoff result is invalid');
  if (result.blocked) {
    const constructionBlocked = result.construction?.attempted === true && result.linuxProfile?.physicalStatus?.complete !== true;
    const lines = [constructionBlocked ? 'DevBridge physical image construction is blocked.' : 'DevBridge setup is blocked.', '', `Reason: ${result.blocker ?? 'unknown blocker'}`];
    if (constructionBlocked) appendConstructionLiveness(lines, result.linuxProfile?.physicalStatus);
    if (constructionBlocked) appendConstructionReadiness(lines, result.linuxProfile?.physicalStatus);
    if (constructionBlocked) appendConstructionDiagnostics(lines, result.linuxProfile?.physicalStatus);
    if (result.resourceConflict?.state === 'approval-required') {
      lines.push(
        '',
        `Conflict consent subject: ${result.resourceConflict.subject}`,
        `Re-run setup with --retire-conflict ${result.resourceConflict.subject} to authorize retirement of only this unchanged inactive subject.`,
      );
    }
    appendWindowsMedia(lines, result.windowsProfile);
    if (constructionBlocked) lines.push('', 'Preserve the canary state; resolve only this blocker, then re-run devbridge setup --construct.');
    if (result.path?.requiresNewShell) lines.push('', `PATH is persisted; until a new shell is opened use: ${result.path.temporaryCommand}`);
    return `${lines.join('\n')}\n`;
  }
  if (result.readyForConstruction) {
    const physical = result.linuxProfile?.physicalStatus;
    const constructionStatus = physical?.state === 'absent'
      ? 'Physical image construction: authorized by status gate, not started'
      : `Physical image construction: authorized to resume from durable ${physical?.state ?? 'incomplete'} frontier`;
    const lines = [
      'DevBridge setup reached the construction gate.',
      '',
      'Linux execution profile: source/package/payload authority ready',
      `Repositories: ${result.repositories?.selectedCount ?? 0} configured`,
      constructionStatus,
    ];
    if (result.lifecycleAuthority?.service === 'ready') lines.push('Windows lifecycle authority: protected service/state ready');
    if (physical?.preflight?.connectivity?.control === 'system' && physical.preflight.connectivity.addressing === 'automatic') {
      lines.push('Physical construction connectivity: verified host-managed DHCP; not claimed as DevBridge-owned network state');
    }
    appendWindowsMedia(lines, result.windowsProfile);
    lines.push('',
      'The setup path performed no image or VM construction.',
      result.path?.requiresNewShell ? `Open a new shell for devbridge on PATH. Until then: ${result.path.temporaryCommand}` : 'The devbridge command is available on PATH.',
      '',
    );
    return lines.join('\n');
  }
  if (result.phase === 'environment-ready') {
    const lines = [
      'DevBridge protected execution environment is ready.',
      '',
      'Linux execution profile: environment and workspace routes verified',
      `Repositories: ${result.repositories?.selectedCount ?? 0} configured`,
      `Execution environments: ${result.environment?.environmentCount ?? 0} ready`,
      '',
      'Operational configuration and execution opt-in remain pending; setup has not started task polling.',
    ];
    appendWindowsMedia(lines, result.windowsProfile);
    lines.push('');
    return lines.join('\n');
  }
  if (result.phase === 'operational-ready') {
    const lines = [
      'Welcome to DevBridge — setup completed successfully.',
      '',
      'Linux execution profile: environment and workspace routes verified',
      `Repositories: ${result.repositories?.selectedCount ?? 0} configured`,
      `Execution environments: ${result.environment?.environmentCount ?? 0} ready`,
      'Controller-plan execution: enabled',
      'Coding-model adapters: disabled (opt-in only)',
    ];
    appendWindowsMedia(lines, result.windowsProfile);
    lines.push(
      '',
      'Setup did not start task polling. Start DevBridge with: devbridge',
      'Check health with: devbridge doctor',
      'Check runtime state with: devbridge status',
      'Change local setup later with: devbridge setup',
      '',
    );
    return lines.join('\n');
  }
  if (result.phase === 'image-complete') {
    return result.construction?.attempted
      ? 'DevBridge physical image construction canary completed.\n'
      : 'Welcome to DevBridge — the Linux production image is already complete.\n';
  }
  if (result.construction?.attempted) {
    const physical = result.linuxProfile?.physicalStatus;
    const lines = [
      'DevBridge physical image construction canary advanced to a durable frontier.',
      '',
      `State: ${physical?.state ?? result.phase ?? 'unknown'}`,
    ];
    if (physical?.phase) lines.push(`Phase: ${physical.phase}`);
    if (physical?.reason) lines.push(`Reason: ${physical.reason}`);
    appendConstructionLiveness(lines, physical);
    appendConstructionReadiness(lines, physical);
    appendConstructionDiagnostics(lines, physical);
    appendWindowsMedia(lines, result.windowsProfile);
    const nextObservationAt = physical?.liveness?.nextObservationAt ?? physical?.readiness?.nextObservationAt;
    if (nextObservationAt) lines.push('', `Re-run devbridge setup --construct at or after ${nextObservationAt} to record the next bounded observation.`, '');
    else lines.push('', 'Do not retry construction automatically; resolve the reported bounded frontier first.', '');
    return lines.join('\n');
  }
  return `DevBridge setup state: ${result.phase}\n`;
}

export async function runDevBridgeSetup({
  home = null,
  requestedRepositories = null,
  construct = false,
  retireConflict = null,
  discoverWindowsMedia = false,
  windowsMediaLocation = null,
  windowsMediaApproval = null,
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
  lifecycleAuthorityReconciler = reconcileWindowsLifecycleAuthorityReadiness,
  profileConfigurationPublisher = createSetupEnvironmentProfileConfiguration,
  profileConfigurationFactory = createWindowsEnvironmentProfileConfiguration,
  resourceConflictFactory = createSetupResourceConflict,
  resourceConflictConsentStoreFactory = createSetupResourceConflictConsentStore,
  elevationRequester = requestWindowsLifecycleAuthorityElevation,
  lifecycleClientFactory = createConfiguredLifecycleAuthorityClient,
  environmentActivationReconciler = reconcileSetupEnvironmentActivation,
  operationalConfigurationFactory = createSetupOperationalConfiguration,
  releaseAuthority = establishUbuntuReleaseAuthority,
  authorityFactory = createUbuntuSetupAuthority,
  canaryFactory = createUbuntuProductionImagePhysicalCanary,
  windowsMediaReconciler = reconcileWindowsInstallMediaSetup,
} = {}) {
  if (typeof construct !== 'boolean') throw new TypeError('DevBridge setup construction option must be boolean');
  if (typeof discoverWindowsMedia !== 'boolean') throw new TypeError('DevBridge Windows media discovery option must be boolean');
  if (windowsMediaLocation != null && windowsMediaApproval != null) throw new TypeError('DevBridge Windows media discovery and approval must be separate setup invocations');
  const requestedConflictConsent = retireConflict == null ? null : setupResourceConflictConsent(retireConflict);
  const root = absoluteHome(home);
  const store = storeFactory(path.join(root, 'state', 'setup.json'));
  const previous = await store.get(STATE_KEY);
  let windowsMedia = null;
  const publicResult = (value) => setupResult({ ...value, windowsMedia });

  try {
    windowsMedia = await windowsMediaReconciler({
      home: root,
      stateDirectory: path.join(root, 'state'),
      platform,
      invoke,
      discover: discoverWindowsMedia,
      location: windowsMediaLocation,
      approval: windowsMediaApproval,
    });
  } catch {
    windowsMedia = Object.freeze({
      protocol: 'devbridge/windows-install-media-selection-status-v1',
      state: 'blocked',
      blocker: 'Windows install media reconciliation failed; inspect the local setup evidence and retry',
      candidates: Object.freeze([]),
      rejectedCount: 0,
      accepted: null,
    });
  }
  if (windowsMedia?.state === 'blocked' && (windowsMediaLocation != null || windowsMediaApproval != null)) {
    return publicResult({ home: root, pathStatus: null, constructionRequested: construct, blocker: windowsMedia.blocker });
  }

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
    return publicResult({ home: root, pathStatus: null, constructionRequested: construct, blocker: error.message });
  }

  const token = await tokenResolver({ env, invoke });
  if (!token) return publicResult({ home: root, pathStatus, constructionRequested: construct, blocker: 'GitHub authentication is unavailable; authenticate with GitHub CLI or provide GH_TOKEN/GITHUB_TOKEN and re-run devbridge setup' });

  let scope;
  try {
    scope = await discover(clientFactory(token));
  } catch (error) {
    return publicResult({ home: root, pathStatus, constructionRequested: construct, blocker: `GitHub discovery failed: ${error.message}` });
  }

  let repositories;
  try {
    const accepted = acceptedRepositorySelection(previous, scope.identity, requestedRepositories);
    repositories = selectRepositories(scope.repositories, { requested: requestedRepositories, accepted });
  } catch (error) {
    return publicResult({ home: root, pathStatus, identity: scope.identity, constructionRequested: construct, blocker: error.message });
  }
  if (repositories.needsSelection) {
    return publicResult({ home: root, pathStatus, identity: scope.identity, repositories, constructionRequested: construct, blocker: repositories.reason });
  }

  const snapshot = previous?.ubuntu?.snapshot ?? defaultUbuntuPackageSnapshot(now());
  await store.set(STATE_KEY, setupState(previous, { identity: scope.identity, repositories, snapshot }));

  const stateDirectory = path.join(root, 'state');
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
      constructionRequested: construct,
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
      constructionRequested: construct,
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
    return publicResult({ home: root, pathStatus, identity: scope.identity, repositories, snapshot, prerequisites, constructionRequested: construct, blocker: `Ubuntu construction authority is unavailable: ${error.message}` });
  }

  const physicalConfig = Object.freeze({
    protocol: UBUNTU_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL,
    stateDirectory: path.join(root, 'state'),
    keyring: release.keyring,
    authority,
    resources: Object.freeze({ memoryBytes: DEFAULT_MEMORY_BYTES, processorCount: DEFAULT_PROCESSORS, diskBytes: DEFAULT_DISK_BYTES }),
  });

  let physical;
  let constructionAttempted = false;
  try {
    const canary = canaryFactory(physicalConfig, { platform, invoke, fetchImpl, signatureVerifierExecutable });
    physical = await canary.status();
    if (construct === true && physical?.blocked !== true && physical?.complete !== true) {
      constructionAttempted = true;
      physical = await canary.run();
    }
  } catch (error) {
    const prefix = constructionAttempted ? 'physical production-image construction failed' : 'read-only production-image status gate failed';
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      constructionRequested: construct,
      constructionAttempted,
      blocker: `${prefix}: ${error.message}`,
    });
  }

  if (physical?.complete !== true) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      physical,
      constructionRequested: construct,
      constructionAttempted,
    });
  }

  let resourceConflict;
  let conflictConsentStore = null;
  let conflictConsentAccepted = false;
  try {
    const conflict = assertSetupResourceConflictPort(await resourceConflictFactory({ stateDirectory, platform, invoke }));
    conflictConsentStore = resourceConflictConsentStoreFactory({ stateDirectory });
    if (!conflictConsentStore || ['load', 'save', 'clear'].some((name) => typeof conflictConsentStore[name] !== 'function')) {
      throw new TypeError('setup resource conflict consent store is incomplete');
    }
    resourceConflict = normalizeSetupResourceConflictObservation(await conflict.inspect());
    const accepted = await conflictConsentStore.load();
    if (resourceConflict.state === 'clear') {
      if (requestedConflictConsent != null) {
        return publicResult({
          home, pathStatus, identity: scope.identity, repositories, snapshot, prerequisites, physical,
          resourceConflict, constructionRequested: construct, constructionAttempted,
          blocker: 'No current local resource conflict matches the supplied consent subject',
        });
      }
      if (accepted != null) await conflictConsentStore.clear();
    } else if (resourceConflict.state === 'blocked') {
      if (accepted != null) await conflictConsentStore.clear();
      return publicResult({
        home, pathStatus, identity: scope.identity, repositories, snapshot, prerequisites, physical,
        resourceConflict, constructionRequested: construct, constructionAttempted,
        blocker: resourceConflict.reason,
      });
    } else {
      const selectedConsent = requestedConflictConsent ?? accepted;
      if (selectedConsent?.subject !== resourceConflict.subject) {
        if (accepted != null) await conflictConsentStore.clear();
        return publicResult({
          home, pathStatus, identity: scope.identity, repositories, snapshot, prerequisites, physical,
          resourceConflict, constructionRequested: construct, constructionAttempted,
          blocker: 'One inactive local resource blocks protected setup and requires exact operator consent',
        });
      }
      if (accepted?.subject !== selectedConsent.subject) await conflictConsentStore.save(selectedConsent);
      conflictConsentAccepted = true;
    }
  } catch (error) {
    return publicResult({
      home, pathStatus, identity: scope.identity, repositories, snapshot, prerequisites, physical,
      resourceConflict, constructionRequested: construct, constructionAttempted,
      blocker: `Local setup resource conflict reconciliation failed: ${error.message}`,
    });
  }

  let profileConfiguration;
  try {
    const publisher = profileConfigurationPublisher({ stateDirectory, now: () => now().toISOString() });
    if (!publisher || typeof publisher.reconcile !== 'function') throw new TypeError('setup profile configuration publisher is incomplete');
    await publisher.reconcile({ subjects: repositories.selected });
    profileConfiguration = profileConfigurationFactory({ stateDirectory, platform, invoke });
  } catch (error) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      physical,
      constructionRequested: construct,
      constructionAttempted,
      blocker: `Environment profile configuration failed: ${error.message}`,
    });
  }

  let lifecycleAuthority;
  try {
    lifecycleAuthority = await lifecycleAuthorityReconciler({
      stateDirectory,
      platform,
      invoke,
      environment: env,
      configuration: profileConfiguration,
      requestElevation: platform === 'win32'
        ? () => elevationRequester({
          home: root,
          launcher: pathStatus.launcher,
          platform,
          invoke,
          environment: env,
        })
        : null,
    });
  } catch (error) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      physical,
      constructionRequested: construct,
      constructionAttempted,
      blocker: `Lifecycle authority reconciliation failed: ${error.message}`,
    });
  }
  if (lifecycleAuthority?.ready !== true) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      lifecycleAuthority,
      physical,
      constructionRequested: construct,
      constructionAttempted,
      blocker: lifecycleAuthority?.blocker ?? 'Protected lifecycle authority is not ready; resolve the reported host boundary and re-run devbridge setup',
    });
  }

  let environmentActivation;
  try {
    const client = lifecycleClientFactory({ stateDirectory, platform, connectTimeoutMs: 3_000 });
    environmentActivation = await environmentActivationReconciler({ client, profile: UBUNTU_SETUP_OUTPUT.profile });
  } catch (error) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      lifecycleAuthority,
      physical,
      constructionRequested: construct,
      constructionAttempted,
      blocker: `Protected environment activation failed: ${error.message}`,
    });
  }
  if (environmentActivation?.ready !== true) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      lifecycleAuthority,
      physical,
      environmentActivation,
      constructionRequested: construct,
      constructionAttempted,
      blocker: environmentActivation?.blocker ?? 'Protected environment did not verify ready after setup activation',
    });
  }

  let operationalConfiguration;
  try {
    const targets = repositories.selected.map((entry) => entry.fullName);
    const owners = [...new Set(targets.map((target) => target.split('/')[0].toLowerCase()))];
    const publisher = operationalConfigurationFactory({ home: root, validate: validateConfig, platform });
    if (!publisher || typeof publisher.reconcile !== 'function') throw new TypeError('setup operational configuration publisher is incomplete');
    operationalConfiguration = await publisher.reconcile({
      protocol: SETUP_OPERATIONAL_CONFIGURATION_REQUEST_PROTOCOL,
      targets,
      submitters: [String(scope.identity.id)],
      owners,
    });
  } catch (error) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      lifecycleAuthority,
      physical,
      environmentActivation,
      constructionRequested: construct,
      constructionAttempted,
      blocker: `Operational configuration activation failed: ${error.message}`,
    });
  }
  if (operationalConfiguration?.ready !== true || operationalConfiguration.executionEnabled !== true) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      lifecycleAuthority,
      physical,
      environmentActivation,
      operationalConfiguration,
      constructionRequested: construct,
      constructionAttempted,
      blocker: operationalConfiguration?.blocker ?? 'Operational configuration did not verify execution ready',
    });
  }

  if (conflictConsentAccepted) {
    try { await conflictConsentStore.clear(); }
    catch (error) {
      return publicResult({
        home, pathStatus, identity: scope.identity, repositories, snapshot, prerequisites, lifecycleAuthority, physical,
        environmentActivation, operationalConfiguration, constructionRequested: construct, constructionAttempted,
        blocker: `Completed setup could not retire its consumed local consent: ${error.message}`,
      });
    }
  }

  return publicResult({
    home: root,
    pathStatus,
    identity: scope.identity,
    repositories,
    snapshot,
    prerequisites,
    lifecycleAuthority,
    physical,
    environmentActivation,
    operationalConfiguration,
    constructionRequested: construct,
    constructionAttempted,
  });
}

export { PROTOCOL as SETUP_STATUS_PROTOCOL };
