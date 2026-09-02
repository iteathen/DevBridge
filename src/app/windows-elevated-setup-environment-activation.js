import process from 'node:process';
import { createConfiguredLifecycleAuthorityClient } from '../runtime/environment-lifecycle-authority-transport.js';
import { readEnvironmentProfileConfigurationRecord } from '../setup/environment-profile-configuration-record.js';
import { createWindowsEnvironmentProfileConfiguration } from '../setup/windows-environment-profile-configuration.js';
import { reconcileSetupEnvironmentActivation } from './setup-environment-activation.js';

export const WINDOWS_ELEVATED_SETUP_ENVIRONMENT_ACTIVATION_PROTOCOL = 'devbridge/windows-elevated-setup-environment-activation-v1';

function result({ ready, changed = false, blocker = null, environmentCount = 0 }) {
  return Object.freeze({
    protocol: WINDOWS_ELEVATED_SETUP_ENVIRONMENT_ACTIVATION_PROTOCOL,
    ready,
    changed,
    blocker,
    environmentCount,
  });
}

export async function reconcileWindowsElevatedSetupEnvironmentActivation({
  stateDirectory,
  platform = process.platform,
} = {}, {
  recordReader = readEnvironmentProfileConfigurationRecord,
  configurationFactory = createWindowsEnvironmentProfileConfiguration,
  clientFactory = createConfiguredLifecycleAuthorityClient,
  activationReconciler = reconcileSetupEnvironmentActivation,
} = {}) {
  if (platform !== 'win32') throw new Error('elevated setup environment activation is only valid on Windows');
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || stateDirectory.includes('\0')) {
    throw new TypeError('elevated setup environment activation state directory is invalid');
  }
  if (typeof recordReader !== 'function' || typeof configurationFactory !== 'function'
      || typeof clientFactory !== 'function' || typeof activationReconciler !== 'function') {
    throw new TypeError('elevated setup environment activation composition is invalid');
  }

  const configuration = configurationFactory({ stateDirectory, platform: 'win32' });
  if (!configuration || typeof configuration.reconcile !== 'function') {
    throw new TypeError('elevated setup environment configuration contract is incomplete');
  }
  const configured = await configuration.reconcile();
  if (configured?.ready !== true) {
    return result({ ready: false, changed: configured?.changed === true, blocker: configured?.blocker ?? 'accepted environment profile configuration did not reconcile' });
  }

  const record = await recordReader({ stateDirectory });
  const declarations = record?.configuration?.declarations;
  if (!Array.isArray(declarations) || declarations.length < 1) {
    return result({ ready: false, blocker: 'accepted environment profile configuration is unavailable' });
  }

  const client = clientFactory({ stateDirectory, platform: 'win32', connectTimeoutMs: 3_000 });
  let changed = configured.changed === true;
  let environmentCount = 0;
  for (const declaration of declarations) {
    const activation = await activationReconciler({ client, profile: declaration.profile });
    changed ||= activation?.changed === true;
    if (activation?.ready !== true) {
      return result({
        ready: false,
        changed,
        blocker: activation?.blocker ?? 'accepted environment did not verify ready after protected activation',
        environmentCount,
      });
    }
    environmentCount += 1;
  }
  return result({ ready: true, changed, environmentCount });
}
