import {
  loadEnvironmentActivityPolicy,
  publishEnvironmentActivityPolicy,
} from './environment-activity-policy.js';

function directory(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError('environment route state directory is invalid');
  }
  return value;
}

export function createEnvironmentActivityPolicyState({ stateDirectory } = {}, {
  load = loadEnvironmentActivityPolicy,
  publish = publishEnvironmentActivityPolicy,
} = {}) {
  const selected = directory(stateDirectory);
  if (typeof load !== 'function' || typeof publish !== 'function') {
    throw new TypeError('environment route state ports are invalid');
  }
  return Object.freeze({
    load: () => load(selected),
    publish: (value) => publish(selected, value),
  });
}
