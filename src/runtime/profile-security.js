import { normalizeRepositoryExecutionStatus, unavailableRepositoryExecutionStatus } from './repository-execution.js';

export function repositoryExecutionReport(status = null) {
  return normalizeRepositoryExecutionStatus(status ?? unavailableRepositoryExecutionStatus());
}

export function declaredProfilePolicy(profile) {
  return {
    legacy: true,
    toolEnforcement: profile.sandbox.enforcement,
    outsideProjectRead: profile.sandbox.outsideProjectRead,
    outsideProjectWrite: profile.sandbox.outsideProjectWrite,
    network: profile.sandbox.network,
  };
}

export function profileSecurityDescription(profile, executionStatus = null) {
  const execution = repositoryExecutionReport(executionStatus);
  const legacyWriteRequest = profile.sandbox.outsideProjectWrite === true;
  return {
    declaredPolicy: declaredProfilePolicy(profile),
    execution: {
      required: true,
      state: execution.state,
      ready: execution.ready,
      identity: execution.identity,
      usable: execution.ready && !legacyWriteRequest,
      reason: legacyWriteRequest
        ? 'legacy profile requests writes outside the repository environment; that declaration does not grant host authority'
        : execution.reason,
    },
  };
}
