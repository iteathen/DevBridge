import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deterministicOperationSecurity } from '../src/runtime/deterministic-operation-security.js';
import { createSetupStatusOperation, projectSetupObservation } from '../src/setup/status-operation.js';

function unavailableObservation() {
  return {
    protocol: 'devbridge/status-observation-v1',
    state: 'unavailable',
    enabled: true,
    configuredCount: 3,
    capability: {
      state: 'unavailable',
      ready: false,
      reason: 'runtime at C:\\Users\\operator\\private for owner/private-repo is unavailable',
    },
  };
}

test('setup.status is host control and never repository execution', () => {
  assert.deepEqual(deterministicOperationSecurity('setup.status'), {
    executionClass: 'control-process',
    repositoryCode: false,
    repositoryExecutionRequired: false,
    executionRequirement: 'host-control',
  });
});

test('setup.status exposes a parameter-free observation contract with no run surface', () => {
  const operation = createSetupStatusOperation({ observeSetup: async () => unavailableObservation() });
  assert.deepEqual(operation.validate({}), {});
  assert.throws(() => operation.validate({ command: 'anything' }), /accepts no parameters/u);
  assert.throws(() => operation.validate({ repository: 'owner/private-repo' }), /accepts no parameters/u);
  assert.deepEqual(operation.publicSchema, { type: 'object', additionalProperties: false, properties: {} });
  assert.equal(Object.hasOwn(operation, 'run'), false);
});

test('setup.status delegates with no remote arguments and returns bounded observed data', async () => {
  let received = null;
  const operation = createSetupStatusOperation({
    observeSetup: async (...args) => {
      received = args;
      return unavailableObservation();
    },
  });

  const observed = await operation.execute(operation.validate({}));
  assert.deepEqual(received, []);
  assert.equal(observed.exitCode, 0);
  assert.equal(observed.stderr, '');
  assert.deepEqual(JSON.parse(observed.stdout), {
    protocol: 'devbridge/setup-status-operation-v1',
    state: 'unavailable',
    ready: false,
    blocked: true,
    enabled: true,
    configuredCount: 3,
    capability: {
      state: 'unavailable',
      ready: false,
      reason: 'runtime at <local-path>',
    },
  });
});

test('setup status projection rejects foreign fields and inconsistent state', () => {
  assert.throws(() => projectSetupObservation({ ...unavailableObservation(), home: 'C:\\private' }), /home is not allowed/u);
  assert.throws(() => projectSetupObservation({
    ...unavailableObservation(),
    capability: { ...unavailableObservation().capability, identity: 'private' },
  }), /identity is not allowed/u);
  assert.throws(() => projectSetupObservation({ ...unavailableObservation(), state: 'ready' }), /inconsistent/u);
  assert.throws(() => projectSetupObservation({
    ...unavailableObservation(),
    capability: { state: 'unavailable', ready: false, reason: 'x'.repeat(1_025) },
  }), /reason is invalid/u);
});

test('runtime composition registers setup.status only through the observation stud', async () => {
  const source = await readFile(new URL('../src/app/runtime.js', import.meta.url), 'utf8');
  assert.match(source, /operationRegistry\.register\('setup\.status', createSetupStatusOperation/u);
  assert.match(source, /observeSetup: \(\) => setupStatusObserver\.observe\(\)/u);
  assert.doesNotMatch(source, /runDevBridgeSetup/u);
  assert.doesNotMatch(source, /setup\.status[^\n]*\.run\(/u);
});
