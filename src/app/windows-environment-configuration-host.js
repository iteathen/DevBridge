import process from 'node:process';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createEnvironmentLifecycle } from './environment-lifecycle.js';
import { createProtectedEnvironmentConfiguration } from './protected-environment-configuration.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { readEnvironmentProfileConfigurationRecord } from '../setup/environment-profile-configuration-record.js';
import { reconcileWindowsLifecycleAuthorityImages } from '../setup/windows-lifecycle-authority-image-adoption.js';
import { createSetupResourceConflictConsentStore } from '../state/setup-resource-conflict-consent-store.js';
import { createWindowsSetupResourceConflict } from '../setup/windows-resource-conflict.js';

function directory(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is invalid`);
  return value;
}

export function createWindowsProtectedEnvironmentConfiguration({
  stateDirectory,
  authorityDirectory,
  platform = process.platform,
  invoke = invokeCommand,
} = {}, {
  recordReader = readEnvironmentProfileConfigurationRecord,
  adoptImages = reconcileWindowsLifecycleAuthorityImages,
  foundationFactory = createEnvironmentFoundation,
  lifecycleFactory = createEnvironmentLifecycle,
  conflictFactory = createWindowsSetupResourceConflict,
  consentStoreFactory = createSetupResourceConflictConsentStore,
} = {}) {
  const ordinary = directory(stateDirectory, 'protected environment configuration stateDirectory');
  const authority = directory(authorityDirectory, 'protected environment configuration authorityDirectory');
  if (platform !== 'win32') throw new Error('protected Windows environment configuration requires a Windows host');
  if (typeof invoke !== 'function' || typeof recordReader !== 'function' || typeof adoptImages !== 'function'
      || typeof foundationFactory !== 'function' || typeof lifecycleFactory !== 'function'
      || typeof conflictFactory !== 'function' || typeof consentStoreFactory !== 'function') {
    throw new TypeError('protected environment configuration composition is incomplete');
  }

  return createProtectedEnvironmentConfiguration({
    readAccepted: () => recordReader({ stateDirectory: ordinary }),
    prepare: async () => {
      const result = await adoptImages({ stateDirectory: ordinary, authorityDirectory: authority, platform, invoke });
      return Object.freeze({ ready: result?.ready === true, changed: result?.changed === true });
    },
    createFoundation: () => foundationFactory({ stateDirectory: authority, platform, invoke }),
    createLifecycle: () => lifecycleFactory({ stateDirectory: authority }),
    createConflict: ({ identity }) => conflictFactory({ identity, platform, invoke }),
    readConsent: () => consentStoreFactory({ stateDirectory: ordinary }).load(),
  });
}
