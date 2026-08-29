import { createEnvironmentActivityPolicyState } from '../runtime/environment-activity-policy-state.js';
import { normalizeEnvironmentActivityPolicy } from '../runtime/environment-activity-policy.js';
import { readLinuxEnvironmentActivityHandoff } from './linux-environment-activity-handoff.js';

function same(left, right) {
  return JSON.stringify(normalizeEnvironmentActivityPolicy(left)) === JSON.stringify(normalizeEnvironmentActivityPolicy(right));
}

export function createLinuxEnvironmentActivityProjection({
  stateDirectory,
  runDirectory = '/run/devbridge',
} = {}, {
  readHandoff = readLinuxEnvironmentActivityHandoff,
  createState = createEnvironmentActivityPolicyState,
} = {}) {
  if (typeof readHandoff !== 'function' || typeof createState !== 'function') {
    throw new TypeError('environment route projection composition is incomplete');
  }
  const local = createState({ stateDirectory });
  if (!local || typeof local.load !== 'function' || typeof local.publish !== 'function') {
    throw new TypeError('environment route projection state is incomplete');
  }
  const read = () => readHandoff({ stateDirectory, runDirectory });
  return Object.freeze({
    async reconcile() {
      const exported = await read();
      if (!exported || typeof exported.subject !== 'string') throw new Error('environment route export evidence is invalid');
      const before = await local.load();
      await local.publish(exported.policy);
      const [accepted, confirmed] = await Promise.all([local.load(), read()]);
      if (accepted == null || !same(accepted, exported.policy)
          || confirmed.subject !== exported.subject || !same(confirmed.policy, exported.policy)) {
        throw new Error('environment route projection changed during reconciliation');
      }
      return Object.freeze({ ready: true, changed: before == null || !same(before, accepted), subject: exported.subject });
    },
  });
}
