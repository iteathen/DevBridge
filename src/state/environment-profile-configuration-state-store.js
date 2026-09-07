import { JsonStateStore } from './json-state-store.js';

export const ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY = 'environment-profile-configuration:v1';

export function createEnvironmentProfileConfigurationStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('environment profile configuration state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    load: () => store.get(ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY),
    save: (value) => store.set(ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY, value),
  });
}
