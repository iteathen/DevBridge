import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeterministicCAcceptancePlan } from '../src/run/deterministic-c-acceptance.js';
import { controllerPlanDigest } from '../src/run/controller-plan.js';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';

const CHALLENGE = 'DEVBRIDGE_ROUTE_42A6E90C';

test('deterministic C acceptance is a stable all-ephemeral controller plan', () => {
  const first = createDeterministicCAcceptancePlan({ challenge: CHALLENGE });
  const second = createDeterministicCAcceptancePlan({ challenge: CHALLENGE });

  assert.deepEqual(first, second);
  assert.equal(controllerPlanDigest(first), controllerPlanDigest(second));
  assert.deepEqual(first.expectedChangedPaths, []);
  assert.deepEqual(first.files.map((entry) => [entry.scope, entry.path]), [
    ['ephemeral', 'CMakeLists.txt'],
    ['ephemeral', 'main.c'],
  ]);
  assert.deepEqual(first.operations.map((entry) => entry.operation), [
    'cmake.configure',
    'cmake.build',
    'ctest.run',
  ]);
  assert.equal(first.operations[2].params.verbose, true);
  assert.match(first.files[0].content, /add_test\(NAME challenge_output COMMAND route_acceptance\)/u);
  assert.match(first.files[0].content, /\$<TARGET_FILE:route_acceptance>/u);
  assert.match(first.files[1].content, new RegExp(CHALLENGE, 'u'));
  for (const operation of first.operations) {
    assert.equal(Object.hasOwn(operation.params, 'hostPath'), false);
    assert.equal(Object.hasOwn(operation.params, 'executable'), false);
    assert.equal(Object.hasOwn(operation.params, 'credentials'), false);
  }
});

test('deterministic C acceptance rejects challenges outside its closed token contract', () => {
  for (const challenge of [
    undefined,
    '',
    'DEVBRIDGE_short',
    'DEVBRIDGE_ROUTE-42A6E90C',
    'DEVBRIDGE_ROUTE_42A6E90C\nNEXT',
    `DEVBRIDGE_${'A'.repeat(97)}`,
  ]) {
    assert.throws(
      () => createDeterministicCAcceptancePlan({ challenge }),
      /challenge is invalid/u,
    );
  }
});

test('acceptance operations retain repository-code classification', () => {
  const registry = createCoreOperationRegistry();
  const plan = createDeterministicCAcceptancePlan({ challenge: CHALLENGE });
  for (const operation of plan.operations) {
    assert.equal(registry.executionClass(operation.operation), 'repository-code');
  }
});
