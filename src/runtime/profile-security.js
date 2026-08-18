import { boundedSandboxReason } from './sandbox-status.js';

const OUTER_NETWORK_MODES = new Set(['deny', 'unrestricted']);

function observedNetwork(profile, providerStatus) {
  if (profile.sandbox.network === 'restricted') return 'unsupported-request';
  if (providerStatus?.verified !== true) return providerStatus?.network ?? 'unverified';
  if (profile.sandbox.network === 'unrestricted') return 'unrestricted-by-policy';
  return providerStatus.network;
}

function unsatisfiedReason(profile, providerStatus) {
  if (profile.sandbox.outsideProjectWrite === true) {
    return 'verified proposal-worker isolation does not permit writes outside the managed project/run roots';
  }
  if (!OUTER_NETWORK_MODES.has(profile.sandbox.network)) {
    return 'the requested restricted network mode has no verified provider implementation';
  }
  if (providerStatus?.verified !== true) {
    return providerStatus?.reason ?? 'the configured outer isolation provider has not been verified';
  }
  return null;
}

export function declaredProfilePolicy(profile) {
  return {
    toolEnforcement: profile.sandbox.enforcement,
    outsideProjectRead: profile.sandbox.outsideProjectRead,
    outsideProjectWrite: profile.sandbox.outsideProjectWrite,
    network: profile.sandbox.network,
  };
}

export function profileSecurityDescription(profile, providerStatus = null) {
  const reason = unsatisfiedReason(profile, providerStatus);
  const verified = providerStatus?.verified === true;
  return {
    declaredPolicy: declaredProfilePolicy(profile),
    enforcement: {
      required: true,
      provider: providerStatus?.provider ?? 'none',
      requestedProvider: providerStatus?.requestedProvider ?? null,
      available: providerStatus?.available ?? false,
      verified,
      verification: providerStatus?.verification ?? 'unavailable',
      usable: reason == null,
      filesystem: verified ? providerStatus.filesystem : (providerStatus?.filesystem ?? 'unverified'),
      network: observedNetwork(profile, providerStatus),
      gitAdministrativeState: verified
        ? providerStatus.gitAdministrativeState
        : (providerStatus?.gitAdministrativeState ?? 'unverified'),
      processTree: providerStatus?.processTree ?? 'unverified',
      boundaryProbe: providerStatus?.boundaryProbe ?? null,
      reason: reason == null ? null : boundedSandboxReason(reason),
    },
  };
}
