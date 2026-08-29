import process from 'node:process';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createEnvironmentLifecycle } from './environment-lifecycle.js';
import { createProtectedEnvironmentConfiguration } from './protected-environment-configuration.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { readLinuxEnvironmentConfigurationHandoff } from '../setup/linux-environment-configuration-handoff.js';
import { createClearSetupResourceConflictPort } from '../setup/resource-conflict.js';

function directory(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is invalid`);
  return value;
}

export function createLinuxProtectedEnvironmentConfiguration({
  stateDirectory,
  authorityDirectory,
  runDirectory = '/run/devbridge',
  platform = process.platform,
  invoke = invokeCommand,
  serviceUserId = process.getuid?.(),
} = {}, {
  recordReader = readLinuxEnvironmentConfigurationHandoff,
  foundationFactory = createEnvironmentFoundation,
  lifecycleFactory = createEnvironmentLifecycle,
  conflictFactory = createClearSetupResourceConflictPort,
} = {}) {
  const ordinary = directory(stateDirectory, 'protected environment configuration stateDirectory');
  const authority = directory(authorityDirectory, 'protected environment configuration authorityDirectory');
  const run = directory(runDirectory, 'protected environment configuration runDirectory');
  if (platform !== 'linux') throw new Error('protected Linux environment configuration requires a Linux host');
  if (!Number.isSafeInteger(serviceUserId) || serviceUserId < 1) throw new TypeError('protected environment configuration service identity is invalid');
  if (typeof invoke !== 'function' || typeof recordReader !== 'function' || typeof foundationFactory !== 'function'
      || typeof lifecycleFactory !== 'function' || typeof conflictFactory !== 'function') {
    throw new TypeError('protected environment configuration composition is incomplete');
  }

  return createProtectedEnvironmentConfiguration({
    readAccepted: () => recordReader({
      stateDirectory: ordinary,
      runDirectory: run,
      serviceUserId,
    }),
    createFoundation: () => foundationFactory({ stateDirectory: authority, platform, invoke }),
    createLifecycle: () => lifecycleFactory({ stateDirectory: authority }),
    createConflict: () => conflictFactory(),
  });
}
