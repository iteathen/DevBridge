import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxProtectedEnvironmentActivityState } from '../src/app/linux-environment-activity-state.js';
import {
  ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,
  normalizeEnvironmentActivityPolicy,
} from '../src/runtime/environment-activity-policy.js';

const POLICY = normalizeEnvironmentActivityPolicy({
  protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,
  routes: [{ subject: '42', profile: 'profile-a', preferred: true, validation: true }],
});

function options() {
  return {
    stateDirectory: '/home/operator/.devbridge/state',
    authorityDirectory: '/var/lib/devbridge/authority/state',
    runDirectory: '/run/devbridge',
    platform: 'linux',
    serviceUserId: 991,
  };
}

test('protected Linux route state persists before exporting through its neutral handoff', async () => {
  let stored = null;
  const calls = [];
  const state = createLinuxProtectedEnvironmentActivityState(options(), {
    createState: ({ stateDirectory }) => {
      assert.equal(stateDirectory, options().authorityDirectory);
      return {
        async load() { calls.push('load'); return structuredClone(stored); },
        async publish(value) { calls.push('publish'); stored = structuredClone(value); return value; },
      };
    },
    publishHandoff: async (request) => {
      calls.push('export');
      const { platform: _platform, ...expected } = options();
      assert.deepEqual(request, { ...expected, policy: POLICY });
      return { ready: true, changed: true };
    },
  });
  assert.deepEqual(await state.publish(POLICY), POLICY);
  assert.deepEqual(calls, ['publish', 'export']);
  assert.deepEqual(await state.load(), POLICY);
});

test('protected Linux route reconciliation repairs an interrupted export and no-ops without durable state', async () => {
  let stored = null;
  let exports = 0;
  const state = createLinuxProtectedEnvironmentActivityState(options(), {
    createState: () => ({
      async load() { return structuredClone(stored); },
      async publish(value) { stored = structuredClone(value); return value; },
    }),
    publishHandoff: async () => { exports += 1; return { ready: true, changed: true }; },
  });
  assert.deepEqual(await state.reconcile(), { ready: true, changed: false });
  assert.equal(exports, 0);
  stored = POLICY;
  assert.deepEqual(await state.reconcile(), { ready: true, changed: true });
  assert.equal(exports, 1);
});

test('protected Linux route state fails closed on foreign platforms and invalid export evidence', async () => {
  assert.throws(() => createLinuxProtectedEnvironmentActivityState({ ...options(), platform: 'win32' }), /requires a Linux host/u);
  const state = createLinuxProtectedEnvironmentActivityState(options(), {
    createState: () => ({ load: async () => POLICY, publish: async (value) => value }),
    publishHandoff: async () => ({ ready: false, changed: false }),
  });
  await assert.rejects(state.reconcile(), /export evidence is invalid/u);
});
