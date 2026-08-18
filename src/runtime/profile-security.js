import { boundedSandboxReason } from './sandbox-status.js';

const OUTER_NETWORK_MODES = new Set(['deny', 'unrestricted']);

export function enforcementProviderReport(providerStatus = null) {
  const status = providerStatus ?? {};
  const probeFailed = status.verification === 'boundary-probe-failed';
  const boundaryProbe = status.boundaryProbe == null
    ? null
    : {
        ...status.boundaryProbe,
        attempted: probeFailed || status.boundaryProbe.attempted === true,
        verified: status.verified === true && status.boundaryProbe.verified === true,
      };
  return {
    requestedProvider: status.requestedProvider ?? null,
    provider: status.provider ?? 'none',
    platform: status.platform ?? process.platform,
    available: status.available ?? false,
    verified: status.verified === true,
    verification: status.verification ?? 'unavailable',
    repositoryCodeExecution: status.repositoryCodeExecution === true,
    filesystem: status.filesystem ?? 'unverified',
    network: status.network ?? 'unverified',
    gitAdministrativeState: status.gitAdministrativeState ?? 'unverified',
    processTree: status.processTree ?? 'unverified',
    boundaryProbe,
    verifiedAt: status.verifiedAt ?? null,
    reason: status.reason ?? null,
  };
}

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
  const provider = enforcementProviderReport(providerStatus);
  const reason = unsatisfiedReason(profile, provider);
  return {
    declaredPolicy: declaredProfilePolicy(profile),
    enforcement: {
      required: true,
      provider: provider.provider,
      requestedProvider: provider.requestedProvider,
      available: provider.available,
      verified: provider.verified,
      verification: provider.verification,
      usable: reason == null,
      filesystem: provider.filesystem,
      network: observedNetwork(profile, provider),
      gitAdministrativeState: provider.gitAdministrativeState,
      processTree: provider.processTree,
      boundaryProbe: provider.boundaryProbe,
      reason: reason == null ? null : boundedSandboxReason(reason),
    },
  };
}
