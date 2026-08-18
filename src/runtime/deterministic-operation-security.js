const STATIC_INSPECTION = new Set([
  'node.syntax-check',
  'toolchain.probe',
]);

const KNOWN_REPOSITORY_CODE = new Set([
  'node.test',
  'cmake.configure',
  'cmake.build',
  'ctest.run',
]);

export function deterministicOperationSecurity(operation) {
  if (operation == null) {
    return {
      executionClass: 'control-process',
      repositoryCode: false,
      sandboxRequired: false,
      enforcementRequirement: 'none',
    };
  }
  if (STATIC_INSPECTION.has(operation)) {
    return {
      executionClass: 'static-inspection',
      repositoryCode: false,
      sandboxRequired: false,
      enforcementRequirement: 'none',
    };
  }
  return {
    executionClass: 'repository-code',
    repositoryCode: true,
    sandboxRequired: true,
    enforcementRequirement: 'verified-os-sandbox',
    knownOperation: KNOWN_REPOSITORY_CODE.has(operation),
  };
}

export function operationSecurityDescription(operation, sandboxStatus = null) {
  const security = deterministicOperationSecurity(operation);
  return {
    ...security,
    usable: !security.sandboxRequired || sandboxStatus?.verified === true,
  };
}
