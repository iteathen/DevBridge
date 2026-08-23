const STATIC_INSPECTION = new Set(['node.syntax-check']);
const CONTROL_PROCESS = new Set(['toolchain.probe', 'setup.status']);
const KNOWN_REPOSITORY_CODE = new Set(['node.test', 'cmake.configure', 'cmake.build', 'ctest.run']);

export function deterministicOperationSecurity(operation) {
  if (operation == null || CONTROL_PROCESS.has(operation)) {
    return {
      executionClass: 'control-process',
      repositoryCode: false,
      repositoryExecutionRequired: false,
      executionRequirement: 'host-control',
    };
  }
  if (STATIC_INSPECTION.has(operation)) {
    return {
      executionClass: 'static-inspection',
      repositoryCode: false,
      repositoryExecutionRequired: false,
      executionRequirement: 'host-static',
    };
  }
  return {
    executionClass: 'repository-code',
    repositoryCode: true,
    repositoryExecutionRequired: true,
    executionRequirement: 'repository-execution',
    knownOperation: KNOWN_REPOSITORY_CODE.has(operation),
  };
}

export function operationSecurityDescription(operation, repositoryExecutionStatus = null) {
  const security = deterministicOperationSecurity(operation);
  return {
    ...security,
    usable: !security.repositoryExecutionRequired || repositoryExecutionStatus?.ready === true,
  };
}
