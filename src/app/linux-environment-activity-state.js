import process from 'node:process';
import { createEnvironmentActivityPolicyState } from '../runtime/environment-activity-policy-state.js';
import { normalizeEnvironmentActivityPolicy } from '../runtime/environment-activity-policy.js';
import { publishLinuxEnvironmentActivityHandoff } from '../setup/linux-environment-activity-handoff.js';

function directory(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is invalid`);
  return value;
}

export function createLinuxProtectedEnvironmentActivityState({
  stateDirectory,
  authorityDirectory,
  runDirectory = '/run/devbridge',
  platform = process.platform,
  serviceUserId = process.getuid?.(),
} = {}, {
  createState = createEnvironmentActivityPolicyState,
  publishHandoff = publishLinuxEnvironmentActivityHandoff,
} = {}) {
  const state = directory(stateDirectory, 'protected environment route state directory');
  const authority = directory(authorityDirectory, 'protected environment route authority directory');
  const run = directory(runDirectory, 'protected environment route run directory');
  if (platform !== 'linux') throw new Error('protected Linux environment route state requires a Linux host');
  if (!Number.isSafeInteger(serviceUserId) || serviceUserId < 1) throw new TypeError('protected environment route service identity is invalid');
  if (typeof createState !== 'function' || typeof publishHandoff !== 'function') {
    throw new TypeError('protected environment route state composition is incomplete');
  }
  const local = createState({ stateDirectory: authority });
  if (!local || typeof local.load !== 'function' || typeof local.publish !== 'function') {
    throw new TypeError('protected environment route state contract is incomplete');
  }

  const exportPolicy = async (policy) => publishHandoff({
    stateDirectory: state,
    authorityDirectory: authority,
    runDirectory: run,
    serviceUserId,
    policy,
  });

  return Object.freeze({
    load: () => local.load(),
    async publish(raw) {
      const policy = normalizeEnvironmentActivityPolicy(raw);
      await local.publish(policy);
      await exportPolicy(policy);
      return policy;
    },
    async reconcile() {
      const policy = await local.load();
      if (policy == null) return Object.freeze({ ready: true, changed: false });
      const exported = await exportPolicy(policy);
      if (exported?.ready !== true || typeof exported.changed !== 'boolean') {
        throw new Error('protected environment route export evidence is invalid');
      }
      return Object.freeze({ ready: true, changed: exported.changed });
    },
  });
}
