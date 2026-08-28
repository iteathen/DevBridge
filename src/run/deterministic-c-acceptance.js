import { CONTROLLER_PLAN_PROTOCOL, normalizeControllerPlan } from './controller-plan.js';

const CHALLENGE = /^DEVBRIDGE_[A-Z0-9_]{8,96}$/u;
const BUILD_ID = 'route-acceptance';

function normalizedChallenge(value) {
  if (typeof value !== 'string' || !CHALLENGE.test(value)) {
    throw new TypeError('deterministic C acceptance challenge is invalid');
  }
  return value;
}

function source(challenge) {
  return `#include <stdio.h>\n\nint main(void) {\n  return puts("${challenge}") == EOF ? 1 : 0;\n}\n`;
}

function project(challenge) {
  return `cmake_minimum_required(VERSION 3.20)\nproject(devbridge_route_acceptance LANGUAGES C)\n\nenable_testing()\nadd_executable(route_acceptance main.c)\nadd_test(NAME challenge_output COMMAND route_acceptance)\nset_tests_properties(challenge_output PROPERTIES PASS_REGULAR_EXPRESSION "${challenge}")\nadd_test(NAME artifact_sha256 COMMAND "\${CMAKE_COMMAND}" -E sha256sum "$<TARGET_FILE:route_acceptance>")\n`;
}

export function createDeterministicCAcceptancePlan({ challenge } = {}) {
  const selected = normalizedChallenge(challenge);
  return normalizeControllerPlan({
    protocol: CONTROLLER_PLAN_PROTOCOL,
    files: [
      { scope: 'ephemeral', action: 'create', path: 'CMakeLists.txt', content: project(selected) },
      { scope: 'ephemeral', action: 'create', path: 'main.c', content: source(selected) },
    ],
    operations: [
      { id: 'configure', operation: 'cmake.configure', params: { sourcePath: 'CMakeLists.txt', buildId: BUILD_ID, buildType: 'Release' } },
      { id: 'build', operation: 'cmake.build', params: { buildId: BUILD_ID, config: 'Release', target: 'route_acceptance' } },
      { id: 'verify', operation: 'ctest.run', params: { buildId: BUILD_ID, config: 'Release', verbose: true } },
    ],
    assertions: [
      { kind: 'exit-equals', operation: 'configure', value: 0 },
      { kind: 'exit-equals', operation: 'build', value: 0 },
      { kind: 'exit-equals', operation: 'verify', value: 0 },
      { kind: 'stdout-contains', operation: 'verify', value: selected },
      { kind: 'stdout-contains', operation: 'verify', value: 'artifact_sha256' },
      { kind: 'stdout-contains', operation: 'verify', value: '100% tests passed' },
    ],
    expectedChangedPaths: [],
  });
}
