const PROTOCOL = 'devbridge/setup-status-operation-v1';
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^;\r\n]*/gu;
const UNC_PATH = /\\\\[^\\\s;]+\\[^;\r\n]*/gu;
const POSIX_HOME_PATH = /\/(?:home|Users|tmp|var\/tmp)\/[^;\r\n]*/gu;
const GITHUB_REPOSITORY_URL = /(?:https?:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gu;
const REPOSITORY_IDENTITY = /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/gu;
const IDENTITY_CHANGE = /GitHub setup identity changed from \S+ to \S+/gu;

function observedResult(stdout, stderr = '', exitCode = 0) {
  const now = new Date().toISOString();
  return Object.freeze({
    exitCode,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    stdout,
    stderr,
    startedAt: now,
    finishedAt: now,
    lastOutputAt: stdout || stderr ? now : null,
  });
}

function paramsOnly(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('setup.status params must be an object');
  if (Object.keys(raw).length !== 0) throw new TypeError('setup.status accepts no parameters');
  return Object.freeze({});
}

function remoteReason(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value
    .replace(WINDOWS_PATH, '<local-path>')
    .replace(UNC_PATH, '<local-path>')
    .replace(POSIX_HOME_PATH, '<local-path>')
    .replace(GITHUB_REPOSITORY_URL, '<repository>')
    .replace(REPOSITORY_IDENTITY, '<repository>')
    .replace(IDENTITY_CHANGE, 'GitHub setup identity changed')
    .slice(0, 4096);
}

function repositoryProjection(value) {
  if (!value || typeof value !== 'object') return null;
  const reasons = {};
  for (const entry of value.excluded ?? []) {
    const reason = typeof entry?.reason === 'string' ? entry.reason : 'other';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return Object.freeze({
    discoveredCount: Number.isSafeInteger(value.discoveredCount) ? value.discoveredCount : null,
    eligibleCount: Number.isSafeInteger(value.eligibleCount) ? value.eligibleCount : null,
    selectedCount: Number.isSafeInteger(value.selectedCount) ? value.selectedCount : null,
    needsSelection: value.needsSelection === true,
    excludedCounts: Object.freeze(reasons),
  });
}

function physicalProjection(value) {
  if (!value || typeof value !== 'object') return null;
  const preflight = value.preflight && typeof value.preflight === 'object'
    ? Object.freeze({
        ready: value.preflight.ready === true,
        reason: remoteReason(value.preflight.reason),
        platform: typeof value.preflight.platform === 'string' ? value.preflight.platform : null,
        capabilities: value.preflight.capabilities && typeof value.preflight.capabilities === 'object'
          ? Object.freeze({
              provider: value.preflight.capabilities.provider === true,
              connectivity: value.preflight.capabilities.connectivity === true,
              keyring: value.preflight.capabilities.keyring === true,
              memory: value.preflight.capabilities.memory === true,
              storage: value.preflight.capabilities.storage === true,
            })
          : null,
        connectivity: value.preflight.connectivity && typeof value.preflight.connectivity === 'object'
          ? Object.freeze({
              control: value.preflight.connectivity.control === 'system' ? 'system' : null,
              addressing: value.preflight.connectivity.addressing === 'automatic' ? 'automatic' : null,
            })
          : null,
      })
    : null;
  return Object.freeze({
    state: typeof value.state === 'string' ? value.state : null,
    phase: typeof value.phase === 'string' ? value.phase : null,
    complete: value.complete === true,
    blocked: value.blocked === true,
    reason: remoteReason(value.reason),
    authorityRegistered: value.authorityRegistered === true,
    preflight,
  });
}

function prerequisiteProjection(value) {
  if (!value || typeof value !== 'object') return null;
  const capabilities = value.capabilities && typeof value.capabilities === 'object'
    ? Object.freeze(Object.fromEntries(
        Object.entries(value.capabilities)
          .filter(([name, ready]) => typeof name === 'string' && typeof ready === 'boolean')
          .map(([name, ready]) => [name, ready]),
      ))
    : null;
  return Object.freeze({
    platform: typeof value.platform === 'string' ? value.platform : null,
    ready: value.ready === true,
    blocker: remoteReason(value.blocker),
    changed: value.changed === true,
    restartRequired: value.restartRequired === true,
    capabilities,
  });
}

function operationalProjection(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.freeze({
    ready: value.ready === true,
    executionEnabled: value.executionEnabled === true,
  });
}

export function projectSetupStatus(result) {
  if (!result || typeof result !== 'object' || result.protocol !== 'devbridge/setup-status-v1') {
    throw new TypeError('setup.status received an invalid setup result');
  }
  return Object.freeze({
    protocol: PROTOCOL,
    phase: typeof result.phase === 'string' ? result.phase : null,
    blocked: result.blocked === true,
    blocker: remoteReason(result.blocker),
    readyForConstruction: result.readyForConstruction === true,
    path: result.path && typeof result.path === 'object'
      ? Object.freeze({
          persisted: result.path.persisted === true,
          changed: result.path.changed === true,
          requiresNewShell: result.path.requiresNewShell === true,
        })
      : null,
    repositories: repositoryProjection(result.repositories),
    prerequisites: prerequisiteProjection(result.prerequisites),
    operational: operationalProjection(result.operational),
    linuxProfile: Object.freeze({
      profile: result.linuxProfile?.profile === 'linux-development' ? 'linux-development' : null,
      snapshot: typeof result.linuxProfile?.snapshot === 'string' ? result.linuxProfile.snapshot : null,
      physicalStatus: physicalProjection(result.linuxProfile?.physicalStatus),
    }),
  });
}

export function createSetupStatusOperation({ runSetup } = {}) {
  if (typeof runSetup !== 'function') throw new TypeError('setup.status requires a setup runner');
  return Object.freeze({
    layer: 'setup',
    publicSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
    validate: paramsOnly,
    async execute() {
      try {
        const projected = projectSetupStatus(await runSetup());
        return observedResult(`${JSON.stringify(projected)}\n`);
      } catch (error) {
        return observedResult('', `setup.status failed: ${remoteReason(error?.message) ?? 'unknown failure'}\n`, 1);
      }
    },
  });
}

export { PROTOCOL as SETUP_STATUS_OPERATION_PROTOCOL };
