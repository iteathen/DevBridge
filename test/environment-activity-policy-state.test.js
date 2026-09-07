import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentActivityPolicyState } from '../src/runtime/environment-activity-policy-state.js';
import { ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL } from '../src/runtime/environment-activity-policy.js';

const STATE = '/state/authority';
const POLICY = Object.freeze({
  protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,
  routes: Object.freeze([]),
});

test('environment route state delegates through one neutral local persistence contract', async () => {
  const calls = [];
  const state = createEnvironmentActivityPolicyState({ stateDirectory: STATE }, {
    async load(directory) {
      calls.push(['load', directory]);
      return POLICY;
    },
    async publish(directory, value) {
      calls.push(['publish', directory, value]);
      return value;
    },
  });
  assert.equal(await state.load(), POLICY);
  assert.equal(await state.publish(POLICY), POLICY);
  assert.deepEqual(calls, [
    ['load', STATE],
    ['publish', STATE, POLICY],
  ]);
});

test('environment route state rejects incomplete ports before use', () => {
  assert.throws(() => createEnvironmentActivityPolicyState({ stateDirectory: '' }), /state directory is invalid/u);
  assert.throws(() => createEnvironmentActivityPolicyState({ stateDirectory: STATE }, {
    load: async () => null,
    publish: null,
  }), /state ports are invalid/u);
});
