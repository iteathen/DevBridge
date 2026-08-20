import test from 'node:test';
import assert from 'node:assert/strict';
import { profileSecurityDescription, repositoryExecutionReport } from '../src/runtime/profile-security.js';
import { REPOSITORY_EXECUTION_STATUS_PROTOCOL } from '../src/runtime/repository-execution.js';

function profile(overrides = {}) {
  return {
    name: 'fixture',
    sandbox: {
      enforcement: 'os', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny', ...overrides,
    },
  };
}

const unavailable = {
  protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL,
  state: 'unavailable', ready: false, identity: null, reason: 'no production implementation',
};
const ready = {
  protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL,
  state: 'ready', ready: true, identity: 'fixture', reason: null,
};

test('legacy profile declaration never becomes repository-execution authority', () => {
  const result = profileSecurityDescription(profile(), unavailable);
  assert.equal(result.declaredPolicy.legacy, true);
  assert.equal(result.declaredPolicy.toolEnforcement, 'os');
  assert.equal(result.execution.ready, false);
  assert.equal(result.execution.usable, false);
  assert.equal(result.execution.reason, 'no production implementation');
});

test('repository execution readiness is reported independently from legacy declaration', () => {
  const result = profileSecurityDescription(profile({ enforcement: 'none' }), ready);
  assert.equal(result.declaredPolicy.toolEnforcement, 'none');
  assert.equal(result.execution.identity, 'fixture');
  assert.equal(result.execution.ready, true);
  assert.equal(result.execution.usable, true);
});

test('legacy outside-write request cannot widen a ready execution boundary', () => {
  const result = profileSecurityDescription(profile({ outsideProjectWrite: true }), ready);
  assert.equal(result.execution.ready, true);
  assert.equal(result.execution.usable, false);
  assert.match(result.execution.reason, /does not grant host authority/u);
});

test('missing execution status normalizes to explicit unavailable state', () => {
  const result = repositoryExecutionReport();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.ready, false);
  assert.equal(result.identity, null);
});
