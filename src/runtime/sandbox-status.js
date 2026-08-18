import process from 'node:process';

export function boundedSandboxReason(value) {
  const text = String(value ?? 'sandbox verification failed').replace(/[\r\n\t]+/gu, ' ').trim();
  return text.length <= 180 ? text : `${text.slice(0, 177)}...`;
}

function boundaryProbe({ attempted = false, verified = false, observations = null } = {}) {
  return {
    attempted,
    verified,
    observations: observations == null ? null : { ...observations },
  };
}

export function unavailableSandboxStatus({
  requestedProvider,
  provider = 'none',
  reason,
  platform = process.platform,
  probeAttempted = false,
} = {}) {
  return {
    requestedProvider,
    provider,
    platform,
    available: false,
    verified: false,
    verification: 'unavailable',
    repositoryCodeExecution: false,
    filesystem: 'unenforced',
    network: 'unenforced',
    gitAdministrativeState: 'unenforced',
    processTree: 'managed-by-parent-runner',
    boundaryProbe: boundaryProbe({ attempted: probeAttempted, verified: false }),
    verifiedAt: null,
    reason: boundedSandboxReason(reason),
  };
}

export function pendingBubblewrapStatus({ requestedProvider }) {
  return {
    requestedProvider,
    provider: 'bubblewrap',
    platform: process.platform,
    available: null,
    verified: false,
    verification: 'not-probed',
    repositoryCodeExecution: false,
    filesystem: 'unverified',
    network: 'unverified',
    gitAdministrativeState: 'unverified',
    processTree: 'bubblewrap-pid-namespace-plus-parent-runner',
    boundaryProbe: boundaryProbe(),
    verifiedAt: null,
    reason: null,
  };
}

export function verifiedBubblewrapStatus({ requestedProvider }) {
  return {
    requestedProvider,
    provider: 'bubblewrap',
    platform: process.platform,
    available: true,
    verified: true,
    verification: 'boundary-probe',
    repositoryCodeExecution: true,
    filesystem: 'project-and-run-scratch-write-only',
    network: 'denied',
    gitAdministrativeState: 'read-only-or-unreachable',
    processTree: 'bubblewrap-pid-namespace-plus-parent-runner',
    boundaryProbe: boundaryProbe({
      attempted: true,
      verified: true,
      observations: {
        projectWriteAllowed: true,
        runScratchWriteAllowed: true,
        arbitraryOutsideReadDenied: true,
        arbitraryOutsideWriteDenied: true,
        controlStateReadDenied: true,
        gitAdministrativeWriteDenied: true,
        networkEgressDenied: true,
        effectiveCapabilitiesDropped: true,
      },
    }),
    verifiedAt: new Date().toISOString(),
    reason: null,
  };
}
