import process from 'node:process';
import { createConfiguredEnvironmentConfigurationClient } from '../runtime/environment-configuration-authority-transport.js';
import { readEnvironmentProfileConfigurationRecord } from './environment-profile-configuration-record.js';
import { createEnvironmentProfileConfigurationProxy } from './environment-profile-configuration-proxy.js';
import { publishLinuxEnvironmentConfigurationHandoff } from './linux-environment-configuration-handoff.js';

export function createLinuxEnvironmentProfileConfiguration({
  stateDirectory,
  platform = process.platform,
  runDirectory = '/run/devbridge',
  userId = process.getuid?.(),
} = {}, {
  recordReader = readEnvironmentProfileConfigurationRecord,
  publisher = publishLinuxEnvironmentConfigurationHandoff,
  configurationFactory = createConfiguredEnvironmentConfigurationClient,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment profile setup stateDirectory is required');
  if (platform !== 'linux') throw new Error('Linux environment profile configuration requires a Linux host');
  if (!Number.isSafeInteger(userId) || userId < 1) throw new TypeError('environment profile setup user identity is invalid');
  if (typeof recordReader !== 'function' || typeof publisher !== 'function' || typeof configurationFactory !== 'function') {
    throw new TypeError('environment profile setup composition is incomplete');
  }

  return createEnvironmentProfileConfigurationProxy({
    readAccepted: () => recordReader({ stateDirectory }),
    publishAccepted: (record) => publisher({ stateDirectory, runDirectory, userId, record }),
    createConfigurationClient: () => configurationFactory({
      stateDirectory,
      platform: 'linux',
      runDirectory,
      connectTimeoutMs: 3_000,
    }),
  });
}
