import process from 'node:process';
import { createConfiguredEnvironmentActivityClient } from '../runtime/environment-activity-authority-transport.js';
import { createConfiguredEnvironmentConfigurationClient } from '../runtime/environment-configuration-authority-transport.js';
import { readEnvironmentProfileConfigurationRecord } from './environment-profile-configuration-record.js';
import { createEnvironmentProfileConfigurationProxy } from './environment-profile-configuration-proxy.js';

export function createWindowsEnvironmentProfileConfiguration({
  stateDirectory,
  platform = process.platform,
} = {}, {
  recordReader = readEnvironmentProfileConfigurationRecord,
  activityFactory = createConfiguredEnvironmentActivityClient,
  configurationFactory = createConfiguredEnvironmentConfigurationClient,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment profile setup stateDirectory is required');
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('environment profile setup platform is invalid');
  if (typeof recordReader !== 'function' || typeof activityFactory !== 'function' || typeof configurationFactory !== 'function') {
    throw new TypeError('environment profile setup composition is incomplete');
  }

  if (platform !== 'win32') throw new Error('Windows environment profile configuration requires a Windows host');
  return createEnvironmentProfileConfigurationProxy({
    readAccepted: () => recordReader({ stateDirectory }),
    createConfigurationClient: () => configurationFactory({ stateDirectory, platform: 'win32', connectTimeoutMs: 3_000 }),
    createResourceObserver: () => activityFactory({ stateDirectory, platform: 'win32', connectTimeoutMs: 3_000 }),
  });
}
