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
import { reconcileSetupImageDistributionPolicy } from './setup-image-distribution-policy.js';
import { reconcileSetupProfileSelection } from './setup-profile-selection.js';
import { reconcileSetupWindowsActivationPolicy } from './setup-windows-activation-policy.js';
import { executionWorkspaceIdentity } from './execution-profile-routing.js';
import { discoverGitHubSetupScope } from '../setup/github-discovery.js';
import { installStableDevBridgeCommand } from '../setup/path-installation.js';
import { reconcileSetupPrerequisites } from '../setup/prerequisite-reconciliation.js';
import { selectRepositoryDefaults } from '../setup/repository-defaults.js';
import { reconcileSerialSelection } from '../setup/serial-reconciliation.js';
import { selectSerialProfileAction } from '../setup/serial-profile-action.js';
import { createUbuntuSetupAuthority, defaultUbuntuPackageSnapshot } from '../setup/ubuntu-authority.js';
import { createUbuntuEnvironmentProfileSource } from '../setup/ubuntu-environment-profile-source.js';
import { establishUbuntuReleaseAuthority } from '../setup/ubuntu-release-authority.js';
import { requestWindowsLifecycleAuthorityElevation } from '../setup/windows-lifecycle-authority-elevation.js';
import { reconcileWindowsLifecycleAuthorityReadiness } from '../setup/windows-lifecycle-authority-readiness.js';
import { createLinuxEnvironmentProfileConfiguration } from '../setup/linux-environment-profile-configuration.js';
import { createWindowsEnvironmentProfileConfiguration } from '../setup/windows-environment-profile-configuration.js';
import { createWindowsEnvironmentProfileSource } from '../setup/windows-environment-profile-source.js';
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
import { reconcileWindowsProductionImageSetup } from './windows-production-image-setup.js';

const PROTOCOL = 'devbridge/setup-status-v1';
const STATE_KEY = 'setup:v1';
const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

function createPlatformEnvironmentProfileConfiguration(options) {
  if (options?.platform === 'linux') return createLinuxEnvironmentProfileConfiguration(options);
  return createWindowsEnvironmentProfileConfiguration(options);
}
const DEFAULT_DISK_BYTES = 32 * 1024 * 1024 * 1024;
const DEFAULT_PROCESSORS = 2;
const LINUX_PROFILE = 'linux-development';
const WINDOWS_PROFILE = 'windows-development';

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
  const preservedSnapshot = typeof previous?.ubuntu?.snapshot === 'string' && /^\d{8}T\d{6}Z$/u.test(previous.ubuntu.snapshot)
    ? previous.ubuntu.snapshot
    : null;
  const selectedSnapshot = snapshot ?? preservedSnapshot;
  return Object.freeze({
    protocol: PROTOCOL,
    identity: Object.freeze({ id: identity.id, login: identity.login }),
    repositories: Object.freeze({ selected: repositories.selected.map((entry) => ({ id: entry.id, fullName: entry.fullName, private: entry.private })) }),
    ubuntu: selectedSnapshot == null ? null : Object.freeze({ snapshot: selectedSnapshot }),
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
    profile: typeof value.item === 'string' ? value.item : null,
    environmentCount: Number.isSafeInteger(value.completedCount) ? value.completedCount : 0,
    profileCount: Number.isSafeInteger(value.totalCount) ? value.totalCount : 0,
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

function publicWindowsActivationPolicy(value) {
  if (!value) return null;
  return Object.freeze({
    state: value.state,
    ready: value.ready,
    changed: value.changed,
    mode: value.mode,
    activationRequired: value.activationRequired,
    blocker: value.blocker,
  });
}

function publicImageDistributionPolicy(value) {
  if (!value) return null;
  return Object.freeze({
    state: value.state,
    ready: value.ready,
    changed: value.changed,
    mode: value.mode,
    blocker: value.blocker,
  });
}

function normalizeImageDistributionPolicyStatus(raw) {
  const allowed = new Set(['protocol', 'state', 'ready', 'changed', 'mode', 'blocker']);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('image distribution policy status must be an object');
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`image distribution policy status.${key} is not allowed`);
  if (raw.protocol !== 'devbridge/setup-image-distribution-policy-status-v1'
      || !['selection-required', 'accepted', 'blocked'].includes(raw.state)
      || typeof raw.ready !== 'boolean'
      || typeof raw.changed !== 'boolean'
      || (raw.blocker != null && (typeof raw.blocker !== 'string' || raw.blocker.length < 1 || raw.blocker.length > 1024))) {
    throw new TypeError('image distribution policy status is invalid');
  }
  if (raw.state === 'accepted') {
    if (!raw.ready || raw.mode !== 'local-reconstruction' || raw.blocker !== null) throw new TypeError('accepted image distribution policy status is inconsistent');
  } else if (raw.ready || raw.mode !== null || typeof raw.blocker !== 'string' || raw.changed) {
    throw new TypeError('unready image distribution policy status is inconsistent');
  }
  return Object.freeze({
    protocol: raw.protocol,
    state: raw.state,
    ready: raw.ready,
    changed: raw.changed,
    mode: raw.mode,
    blocker: raw.blocker,
  });
}

function normalizeWindowsActivationPolicyStatus(raw) {
  const allowed = new Set(['protocol', 'state', 'ready', 'changed', 'mode', 'activationRequired', 'blocker']);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Windows activation policy status must be an object');
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`Windows activation policy status.${key} is not allowed`);
  if (raw.protocol !== 'devbridge/setup-windows-activation-policy-status-v1'
      || !['selection-required', 'accepted', 'blocked'].includes(raw.state)
      || typeof raw.ready !== 'boolean'
      || typeof raw.changed !== 'boolean'
      || raw.activationRequired !== true
      || (raw.blocker != null && (typeof raw.blocker !== 'string' || raw.blocker.length < 1 || raw.blocker.length > 1024))) {
    throw new TypeError('Windows activation policy status is invalid');
  }
  if (raw.state === 'accepted') {
    if (!raw.ready || raw.mode !== 'configure-later' || raw.blocker !== null) throw new TypeError('accepted Windows activation policy status is inconsistent');
  } else if (raw.ready || raw.mode !== null || typeof raw.blocker !== 'string' || raw.changed) {
    throw new TypeError('unready Windows activation policy status is inconsistent');
  }
  return Object.freeze({
    protocol: raw.protocol,
    state: raw.state,
    ready: raw.ready,
    changed: raw.changed,
    mode: raw.mode,
    activationRequired: true,
    blocker: raw.blocker,
  });
}

function normalizeProfileSelection(value) {
  const allowedKeys = new Set(['protocol', 'state', 'revision', 'changed', 'profiles', 'pendingProfiles', 'source']);
  if (!value || value.protocol !== 'devbridge/setup-profile-selection-status-v1'
      || !['accepted', 'deferred'].includes(value.state)
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.changed !== 'boolean'
      || !Array.isArray(value.profiles)
      || (value.pendingProfiles != null && !Array.isArray(value.pendingProfiles))
      || !['default', 'accepted', 'working', 'explicit'].includes(value.source)) {
    throw new TypeError('setup profile selection result is invalid');
  }
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw new TypeError(`setup profile selection result.${key} is not allowed`);
  const allowed = new Set([LINUX_PROFILE, WINDOWS_PROFILE]);
  const normalize = (profiles, name) => {
    if (profiles.length > allowed.size || new Set(profiles).size !== profiles.length
        || profiles.some((profile) => !allowed.has(profile))) {
      throw new TypeError(`${name} is invalid`);
    }
    return Object.freeze([...profiles].sort((left, right) => left.localeCompare(right)));
  };
  const profiles = normalize(value.profiles, 'setup selected profiles');
  const pendingProfiles = value.pendingProfiles == null ? null : normalize(value.pendingProfiles, 'setup pending profiles');
  if (value.state === 'accepted' && pendingProfiles !== null) throw new TypeError('accepted setup profile selection cannot be pending');
  if (value.state === 'deferred' && value.changed) throw new TypeError('deferred setup profile selection cannot report a change');
  return Object.freeze({
    protocol: value.protocol,
    state: value.state,
    revision: value.revision,
    changed: value.changed,
    profiles,
    pendingProfiles,
    source: value.source,
  });
}

function hasProfile(selection, profile) {
  return selection?.state === 'accepted' && selection.profiles.includes(profile);
}

function selectedProfileSources(selection, factories) {
  if (!factories || typeof factories !== 'object' || Array.isArray(factories)) {
    throw new TypeError('setup profile source factories are invalid');
  }
  return Object.freeze(selection.profiles.map((profile) => {
    const factory = factories[profile];
    if (typeof factory !== 'function') throw new Error(`accepted profile ${profile} has no local declaration source`);
    const source = factory();
    if (!source || typeof source.resolve !== 'function') throw new TypeError('setup profile declaration source is incomplete');
    return source;
  }));
}

function selectedActivationProfiles(publication, selection) {
  const declarations = publication?.record?.configuration?.declarations;
  if (!Array.isArray(declarations)) throw new Error('accepted environment profile publication is incomplete');
  const published = declarations.map((entry) => entry?.profile);
  if (published.some((profile) => typeof profile !== 'string') || new Set(published).size !== published.length) {
    throw new Error('accepted environment profile publication is invalid');
  }
  if (published.length !== selection.profiles.length
      || selection.profiles.some((profile) => !published.includes(profile))) {
    throw new Error('accepted environment profile publication does not cover every selected profile');
  }
  return Object.freeze(selection.profiles.filter((profile) => published.includes(profile)));
}

function windowsImageBlocker(media, construction, platform) {
  const constructionBlocker = windowsConstructionBlocker(media, construction, platform);
  if (constructionBlocker) return constructionBlocker;
  if (construction?.state !== 'complete') return construction?.reason ?? 'Windows production image construction is incomplete';
  return null;
}

function windowsConstructionBlocker(media, construction, platform) {
  if (!media || media.state === 'platform-unavailable') {
    return platform === 'win32'
      ? 'Windows execution profile media status is unavailable; execution remains disabled'
      : 'Windows execution profile requires a Windows host provider; execution remains disabled';
  }
  if (media.state === 'blocked') return media.blocker ?? 'Windows install media reconciliation is blocked';
  if (media.state === 'source-required') return 'Windows execution profile requires an accepted install-media source';
  if (media.state === 'selection-required') return 'Windows execution profile requires explicit approval of one exact install-media candidate';
  if (media.state !== 'accepted') return 'Windows execution profile install-media state is not ready';
  if (!construction || construction.state === 'platform-unavailable') return 'Windows production image status is unavailable';
  if (construction?.state === 'blocked') return construction.reason ?? 'Windows production image status is blocked';
  return null;
}

function constructionDecision(profileSelection, physical, windowsMedia, windowsConstruction, platform) {
  const observations = [];
  if (profileSelection.profiles.includes(LINUX_PROFILE)) {
    observations.push(Object.freeze({
      profile: LINUX_PROFILE,
      complete: physical?.complete === true,
      blocked: physical?.blocked === true,
      reason: physical?.blocked === true ? (physical.reason ?? 'selected profile construction is blocked') : null,
    }));
  }
  if (profileSelection.profiles.includes(WINDOWS_PROFILE)) {
    const blocker = windowsConstructionBlocker(windowsMedia, windowsConstruction, platform);
    observations.push(Object.freeze({
      profile: WINDOWS_PROFILE,
      complete: windowsConstruction?.state === 'complete',
      blocked: blocker != null,
      reason: blocker,
    }));
  }
  return selectSerialProfileAction({ profiles: profileSelection.profiles, observations }, {
    order: [LINUX_PROFILE, WINDOWS_PROFILE],
  });
}

async function createSetupResourceConflict({ stateDirectory, platform, invoke }) {
  if (platform !== 'win32') return createClearSetupResourceConflictPort();
  const identity = await readLocalIdentity({ directory: path.join(path.resolve(stateDirectory), 'environment-foundation') });
  if (identity == null) throw new Error('accepted environment foundation identity is unavailable');
  return createWindowsSetupResourceConflict({ identity, platform, invoke });
}

function setupResult({ home, pathStatus, repositories = null, identity = null, profileSelection = null, snapshot = null, prerequisites = null, lifecycleAuthority = null, physical = null, resourceConflict = null, environmentActivation = null, operationalConfiguration = null, windowsMedia = null, windowsConstruction = null, windowsDistributionPolicy = null, windowsActivationPolicy = null, blocker = null, constructionRequested = false, constructionAttempted = false, constructionProfile = null }) {
  const readyForConstruction = constructionAttempted !== true && physical?.blocked === false && physical?.complete !== true;
  const linuxRequested = profileSelection?.profiles.includes(LINUX_PROFILE) === true;
  const windowsRequested = profileSelection?.profiles.includes(WINDOWS_PROFILE) === true;
  const activePhysical = constructionProfile === WINDOWS_PROFILE ? windowsConstruction?.physical : physical;
  const activeBlocked = constructionAttempted && (activePhysical?.blocked === true
    || (constructionProfile === WINDOWS_PROFILE && windowsConstruction?.state === 'blocked'));
  return Object.freeze({
    protocol: PROTOCOL,
    home,
    phase: blocker ? 'blocked'
      : profileSelection?.state === 'deferred' ? 'profile-selection-deferred'
      : profileSelection?.profiles.length === 0 ? 'profiles-disabled'
      : operationalConfiguration?.ready === true ? 'operational-ready'
      : environmentActivation?.ready === true ? 'environment-ready'
      : constructionAttempted ? activePhysical?.state ?? windowsConstruction?.state ?? 'constructing'
      : readyForConstruction ? 'ready-for-construction'
      : physical?.complete ? 'image-complete'
      : physical?.state ?? 'discovering',
    blocked: blocker != null || physical?.blocked === true || activeBlocked,
    blocker: blocker ?? (activeBlocked ? (activePhysical?.reason ?? windowsConstruction?.reason ?? 'selected profile construction is blocked') : physical?.reason) ?? null,
    readyForConstruction,
    construction: Object.freeze({ requested: constructionRequested, attempted: constructionAttempted, profile: constructionProfile }),
    path: pathStatus,
    github: identity ? Object.freeze({ id: identity.id, login: identity.login }) : null,
    repositories,
    profileSelection,
    prerequisites,
    resourceConflict: publicResourceConflict(resourceConflict),
    lifecycleAuthority: publicLifecycleAuthority(lifecycleAuthority),
    environment: publicEnvironmentActivation(environmentActivation),
    operational: publicOperationalConfiguration(operationalConfiguration),
    linuxProfile: linuxRequested ? Object.freeze({ profile: LINUX_PROFILE, snapshot, physicalStatus: physical }) : null,
    windowsProfile: windowsRequested ? Object.freeze({
      profile: WINDOWS_PROFILE,
      media: windowsMedia,
      construction: windowsConstruction,
      distributionPolicy: publicImageDistributionPolicy(windowsDistributionPolicy),
      activationPolicy: publicWindowsActivationPolicy(windowsActivationPolicy),
    }) : null,
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

function appendWindowsMedia(lines, windowsProfile, { constructionActive = false } = {}) {
  const distribution = windowsProfile?.distributionPolicy;
  if (distribution) {
    lines.push('', 'Windows image distribution policy:');
    if (distribution.state === 'accepted' && distribution.mode === 'local-reconstruction') {
      lines.push('Local reconstruction (prepared image bytes remain local)');
    } else if (distribution.state === 'selection-required') {
      lines.push(
        'Selection required before protected Windows environment activation.',
        'Keep prepared bytes local: devbridge setup --windows-distribution local-reconstruction',
      );
    } else if (distribution.state === 'blocked') {
      lines.push(`Blocked: ${distribution.blocker ?? 'local distribution-policy reconciliation failed'}`);
    }
  }
  const policy = windowsProfile?.activationPolicy;
  if (policy) {
    lines.push('', 'Windows activation policy:');
    if (policy.state === 'accepted' && policy.mode === 'configure-later') {
      lines.push('Configure later (Windows activation remains required)');
    } else if (policy.state === 'selection-required') {
      lines.push(
        'Selection required before protected Windows environment activation.',
        'Defer activation explicitly: devbridge setup --windows-activation later',
      );
    } else if (policy.state === 'blocked') {
      lines.push(`Blocked: ${policy.blocker ?? 'local activation-policy reconciliation failed'}`);
    }
  }
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
    const construction = windowsProfile.construction;
    const label = constructionActive ? 'Construction status' : 'Read-only construction gate';
    if (construction?.state === 'blocked') lines.push(`${label} blocked: ${construction.reason ?? 'unknown blocker'}`);
    else if (construction?.physical) lines.push(`${label}: ${construction.physical.state ?? construction.state}`);
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

function activeConstructionPhysical(result) {
  return result.construction?.profile === WINDOWS_PROFILE
    ? result.windowsProfile?.construction?.physical
    : result.linuxProfile?.physicalStatus;
}

function activeConstructionLabel(result) {
  return result.construction?.profile === WINDOWS_PROFILE ? 'Windows' : 'Linux';
}

export function formatSetupHandoff(result) {
  if (!result || result.protocol !== PROTOCOL) throw new TypeError('setup handoff result is invalid');
  if (result.blocked) {
    const activePhysical = activeConstructionPhysical(result);
    const constructionBlocked = result.construction?.attempted === true && activePhysical?.complete !== true;
    const lines = [constructionBlocked ? 'DevBridge physical image construction is blocked.' : 'DevBridge setup is blocked.', '', `Reason: ${result.blocker ?? 'unknown blocker'}`];
    if (constructionBlocked) appendConstructionLiveness(lines, activePhysical);
    if (constructionBlocked) appendConstructionReadiness(lines, activePhysical);
    if (constructionBlocked) appendConstructionDiagnostics(lines, activePhysical);
    if (result.resourceConflict?.state === 'approval-required') {
      lines.push(
        '',
        `Conflict consent subject: ${result.resourceConflict.subject}`,
        `Re-run setup with --retire-conflict ${result.resourceConflict.subject} to authorize retirement of only this unchanged inactive subject.`,
      );
    }
    appendWindowsMedia(lines, result.windowsProfile, { constructionActive: result.construction?.profile === WINDOWS_PROFILE });
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
  if (result.phase === 'profile-selection-deferred') {
    return 'DevBridge execution-profile setup was deferred.\n\nRepository selection was preserved, no profile setup work was performed, and execution remains fail-closed. Re-run devbridge setup --profiles <linux|windows|both|none> when ready.\n';
  }
  if (result.phase === 'profiles-disabled') {
    return 'DevBridge setup saved an empty execution-profile selection.\n\nRepository selection was preserved, no VM profile setup work was performed, and repository execution remains unavailable.\n';
  }
  if (result.phase === 'environment-ready') {
    const lines = [
      'DevBridge protected execution environment is ready.',
      '',
      `Execution profiles: ${result.environment?.profileCount ?? 0} selected environment(s) verified`,
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
      `Execution profiles: ${result.environment?.profileCount ?? 0} selected environment(s) verified`,
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
    const label = activeConstructionLabel(result);
    return result.construction?.attempted
      ? `DevBridge ${label} physical image construction canary completed.\n`
      : 'Welcome to DevBridge — the Linux production image is already complete.\n';
  }
  if (result.construction?.attempted) {
    const physical = activeConstructionPhysical(result);
    const label = activeConstructionLabel(result);
    const lines = [
      `DevBridge ${label} physical image construction canary advanced to a durable frontier.`,
      '',
      `State: ${physical?.state ?? result.phase ?? 'unknown'}`,
    ];
    if (physical?.phase) lines.push(`Phase: ${physical.phase}`);
    if (physical?.reason) lines.push(`Reason: ${physical.reason}`);
    appendConstructionLiveness(lines, physical);
    appendConstructionReadiness(lines, physical);
    appendConstructionDiagnostics(lines, physical);
    appendWindowsMedia(lines, result.windowsProfile, { constructionActive: result.construction?.profile === WINDOWS_PROFILE });
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
  profileChoice = null,
  construct = false,
  retireConflict = null,
  discoverWindowsMedia = false,
  windowsMediaLocation = null,
  windowsMediaApproval = null,
  windowsDistribution = null,
  windowsActivation = null,
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
  profileConfigurationFactory = createPlatformEnvironmentProfileConfiguration,
  resourceConflictFactory = createSetupResourceConflict,
  resourceConflictConsentStoreFactory = createSetupResourceConflictConsentStore,
  elevationRequester = requestWindowsLifecycleAuthorityElevation,
  lifecycleClientFactory = createConfiguredLifecycleAuthorityClient,
  environmentActivationReconciler = reconcileSetupEnvironmentActivation,
  serialReconciler = reconcileSerialSelection,
  operationalConfigurationFactory = createSetupOperationalConfiguration,
  releaseAuthority = establishUbuntuReleaseAuthority,
  authorityFactory = createUbuntuSetupAuthority,
  canaryFactory = createUbuntuProductionImagePhysicalCanary,
  profileSelectionReconciler = reconcileSetupProfileSelection,
  imageDistributionPolicyReconciler = reconcileSetupImageDistributionPolicy,
  windowsActivationPolicyReconciler = reconcileSetupWindowsActivationPolicy,
  windowsMediaReconciler = reconcileWindowsInstallMediaSetup,
  windowsConstructionReconciler = reconcileWindowsProductionImageSetup,
  profileSourceFactories = Object.freeze({
    [LINUX_PROFILE]: createUbuntuEnvironmentProfileSource,
    [WINDOWS_PROFILE]: createWindowsEnvironmentProfileSource,
  }),
  workspaceIdentity = executionWorkspaceIdentity,
} = {}) {
  if (typeof construct !== 'boolean') throw new TypeError('DevBridge setup construction option must be boolean');
  if (typeof discoverWindowsMedia !== 'boolean') throw new TypeError('DevBridge Windows media discovery option must be boolean');
  if (windowsMediaLocation != null && windowsMediaApproval != null) throw new TypeError('DevBridge Windows media discovery and approval must be separate setup invocations');
  const requestedConflictConsent = retireConflict == null ? null : setupResourceConflictConsent(retireConflict);
  const root = absoluteHome(home);
  const stateDirectory = path.join(root, 'state');
  const store = storeFactory(path.join(stateDirectory, 'setup.json'));
  const previous = await store.get(STATE_KEY);
  let profileSelection = null;
  let windowsMedia = null;
  let windowsConstruction = null;
  let windowsDistributionPolicy = null;
  let windowsActivationPolicy = null;
  let constructionProfile = null;
  const publicResult = (value) => setupResult({ ...value, profileSelection, windowsMedia, windowsConstruction, windowsDistributionPolicy, windowsActivationPolicy, constructionProfile });
  const reconcileWindowsConstruction = async (action) => {
    try {
      return await windowsConstructionReconciler({ home: root, stateDirectory, platform, invoke, action });
    } catch {
      return Object.freeze({
        protocol: 'devbridge/windows-production-image-setup-status-v1',
        state: 'blocked',
        reason: action === 'advance'
          ? 'Windows production image construction failed; inspect local setup evidence and retry'
          : 'Windows production image status reconciliation failed; inspect local setup evidence and retry',
        physical: null,
      });
    }
  };

  try {
    profileSelection = normalizeProfileSelection(await profileSelectionReconciler({
      stateDirectory,
      choice: profileChoice,
    }));
  } catch (error) {
    return publicResult({ home: root, pathStatus: null, constructionRequested: construct, blocker: `Execution-profile selection failed: ${error.message}` });
  }
  const linuxRequested = hasProfile(profileSelection, LINUX_PROFILE);
  const windowsRequested = hasProfile(profileSelection, WINDOWS_PROFILE);
  if (construct && (profileSelection.state !== 'accepted' || profileSelection.profiles.length === 0)) {
    return publicResult({ home: root, pathStatus: null, constructionRequested: construct, blocker: 'Physical image construction requires at least one accepted execution profile' });
  }
  if ((windowsMediaLocation != null || windowsMediaApproval != null || windowsDistribution != null || windowsActivation != null) && !windowsRequested) {
    return publicResult({ home: root, pathStatus: null, constructionRequested: construct, blocker: 'Windows setup options require the selected Windows execution profile' });
  }

  if (windowsRequested) {
    try {
      windowsDistributionPolicy = normalizeImageDistributionPolicyStatus(await imageDistributionPolicyReconciler({
        stateDirectory,
        profile: WINDOWS_PROFILE,
        choice: windowsDistribution,
      }));
    } catch {
      windowsDistributionPolicy = Object.freeze({
        protocol: 'devbridge/setup-image-distribution-policy-status-v1',
        state: 'blocked',
        ready: false,
        changed: false,
        mode: null,
        blocker: 'Image distribution-policy reconciliation failed; inspect local setup evidence and retry',
      });
    }
    if (windowsDistribution != null && windowsDistributionPolicy?.ready !== true) {
      return publicResult({ home: root, pathStatus: null, constructionRequested: construct, blocker: windowsDistributionPolicy.blocker });
    }
    try {
      windowsActivationPolicy = normalizeWindowsActivationPolicyStatus(await windowsActivationPolicyReconciler({
        stateDirectory,
        choice: windowsActivation,
      }));
    } catch {
      windowsActivationPolicy = Object.freeze({
        protocol: 'devbridge/setup-windows-activation-policy-status-v1',
        state: 'blocked',
        ready: false,
        changed: false,
        mode: null,
        activationRequired: true,
        blocker: 'Windows activation-policy reconciliation failed; inspect local setup evidence and retry',
      });
    }
    if (windowsActivation != null && windowsActivationPolicy?.ready !== true) {
      return publicResult({ home: root, pathStatus: null, constructionRequested: construct, blocker: windowsActivationPolicy.blocker });
    }
    try {
      windowsMedia = await windowsMediaReconciler({
        home: root,
        stateDirectory,
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
    if (windowsMedia?.state === 'accepted') {
      windowsConstruction = await reconcileWindowsConstruction('observe');
    }
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

  const snapshot = linuxRequested ? previous?.ubuntu?.snapshot ?? defaultUbuntuPackageSnapshot(now()) : null;
  await store.set(STATE_KEY, setupState(previous, { identity: scope.identity, repositories, snapshot }));

  if (profileSelection.state === 'deferred' || profileSelection.profiles.length === 0) {
    return publicResult({ home: root, pathStatus, identity: scope.identity, repositories, snapshot, constructionRequested: construct });
  }
  if (!linuxRequested && construct) {
    const decision = constructionDecision(profileSelection, null, windowsMedia, windowsConstruction, platform);
    constructionProfile = decision.profile;
    if (decision.state === 'blocked') {
      return publicResult({
        home: root,
        pathStatus,
        identity: scope.identity,
        repositories,
        snapshot,
        constructionRequested: construct,
        blocker: decision.reason,
      });
    }
    if (decision.state === 'ready') {
      windowsConstruction = await reconcileWindowsConstruction('advance');
      return publicResult({
        home: root,
        pathStatus,
        identity: scope.identity,
        repositories,
        snapshot,
        constructionRequested: construct,
        constructionAttempted: true,
      });
    }
  }
  let prerequisites = null;
  let physical = null;
  let constructionAttempted = false;
  if (linuxRequested) {
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

  let canary;
  try {
    canary = canaryFactory(physicalConfig, { platform, invoke, fetchImpl, signatureVerifierExecutable });
    physical = await canary.status();
  } catch (error) {
    return publicResult({
      home: root,
      pathStatus,
      identity: scope.identity,
      repositories,
      snapshot,
      prerequisites,
      constructionRequested: construct,
      constructionAttempted,
      blocker: `read-only production-image status gate failed: ${error.message}`,
    });
  }

  if (construct) {
    const decision = constructionDecision(profileSelection, physical, windowsMedia, windowsConstruction, platform);
    constructionProfile = decision.profile;
    if (decision.state === 'blocked') {
      return publicResult({
        home: root,
        pathStatus,
        identity: scope.identity,
        repositories,
        snapshot,
        prerequisites,
        physical,
        constructionRequested: construct,
        blocker: decision.reason,
      });
    }
    if (decision.state === 'ready') {
      constructionAttempted = true;
      if (decision.profile === WINDOWS_PROFILE) {
        windowsConstruction = await reconcileWindowsConstruction('advance');
      } else {
        try {
          physical = await canary.run();
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
            blocker: `physical production-image construction failed: ${error.message}`,
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
        physical,
        constructionRequested: construct,
        constructionAttempted,
      });
    }
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
  }

  if (windowsRequested) {
    const blocker = windowsImageBlocker(windowsMedia, windowsConstruction, platform);
    if (blocker) {
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
        blocker,
      });
    }
    if (windowsDistributionPolicy?.ready !== true) {
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
        blocker: windowsDistributionPolicy?.blocker ?? 'Image distribution policy requires an explicit local selection',
      });
    }
    if (windowsActivationPolicy?.ready !== true) {
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
        blocker: windowsActivationPolicy?.blocker ?? 'Windows activation policy requires an explicit local selection',
      });
    }
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
  let activationProfiles;
  try {
    const sources = selectedProfileSources(profileSelection, profileSourceFactories);
    const publisher = profileConfigurationPublisher({
      stateDirectory,
      sources,
      identify: workspaceIdentity,
      now: () => now().toISOString(),
    });
    if (!publisher || typeof publisher.reconcile !== 'function') throw new TypeError('setup profile configuration publisher is incomplete');
    const publication = await publisher.reconcile({ subjects: repositories.selected });
    activationProfiles = selectedActivationProfiles(publication, profileSelection);
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
    environmentActivation = await serialReconciler({
      items: activationProfiles,
      reconcile: async (profile) => {
        const observed = await environmentActivationReconciler({ client, profile });
        return Object.freeze({
          ready: observed?.ready === true,
          changed: observed?.changed === true,
          blocker: observed?.ready === true
            ? null
            : observed?.blocker ?? 'accepted environment did not verify ready after protected activation',
        });
      },
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
      blocker: environmentActivation?.state === 'pending'
        ? 'Additional accepted environment profile activation remains; re-run devbridge setup'
        : environmentActivation?.blocker ?? 'Protected environment did not verify ready after setup activation',
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
