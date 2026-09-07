import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxEnvironmentActivityProjection } from '../src/setup/linux-environment-activity-projection.js';
import {
  ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,
  normalizeEnvironmentActivityPolicy,
} from '../src/runtime/environment-activity-policy.js';

const POLICY = normalizeEnvironmentActivityPolicy({
  protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,
  routes: [{ subject: '42', profile: 'profile-a', preferred: true, validation: true }],
});

function projection({ initial = null, exportFactory = null } = {}) {
  let stored = structuredClone(initial);
  const requests = [];
  let reads = 0;
  const selected = createLinuxEnvironmentActivityProjection({
    stateDirectory: '/home/operator/.devbridge/state',
    runDirectory: '/run/devbridge',
  }, {
    readHandoff: async (request) => {
      requests.push(request);
      reads += 1;
      return exportFactory?.(reads) ?? { policy: POLICY, subject: 'a'.repeat(64) };
    },
    createState: ({ stateDirectory }) => {
      assert.equal(stateDirectory, '/home/operator/.devbridge/state');
      return {
        async load() { return structuredClone(stored); },
        async publish(value) { stored = structuredClone(value); return value; },
      };
    },
  });
  return { selected, requests, get stored() { return stored; } };
}

test('ordinary Linux route projection imports and reverifies one fixed protected export', async () => {
  const values = projection();
  assert.deepEqual(await values.selected.reconcile(), {
    ready: true,
    changed: true,
    subject: 'a'.repeat(64),
  });
  assert.deepEqual(values.stored, POLICY);
  assert.deepEqual(values.requests, [
    { stateDirectory: '/home/operator/.devbridge/state', runDirectory: '/run/devbridge' },
    { stateDirectory: '/home/operator/.devbridge/state', runDirectory: '/run/devbridge' },
  ]);
});

test('ordinary Linux route projection reports idempotence and rejects export drift', async () => {
  const unchanged = projection({ initial: POLICY });
  assert.equal((await unchanged.selected.reconcile()).changed, false);

  const changed = projection({ exportFactory: (read) => ({ policy: POLICY, subject: (read === 1 ? 'a' : 'b').repeat(64) }) });
  await assert.rejects(changed.selected.reconcile(), /changed during reconciliation/u);
});
