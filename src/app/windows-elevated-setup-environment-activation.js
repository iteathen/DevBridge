import process from 'node:process';
import { createLocalEnvironmentOperator } from './environment-operator-runtime.js';
import { readEnvironmentProfileConfigurationRecord } from '../setup/environment-profile-configuration-record.js';
import { createWindowsEnvironmentProfileConfiguration } from '../setup/windows-environment-profile-configuration.js';
import { createWindowsLifecycleAuthorityPlan } from '../setup/windows-lifecycle-authority.js';
import { inspectWindowsLifecycleAuthorityReadinessHost } from '../setup/windows-lifecycle-authority-readiness.js';
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
  invoke,
  environment = process.env,
} = {}, {
  recordReader = readEnvironmentProfileConfigurationRecord,
  configurationFactory = createWindowsEnvironmentProfileConfiguration,
  hostInspector = inspectWindowsLifecycleAuthorityReadinessHost,
  planFactory = createWindowsLifecycleAuthorityPlan,
  operatorFactory = createLocalEnvironmentOperator,
  activationReconciler = reconcileSetupEnvironmentActivation,
} = {}) {
  if (platform !== 'win32') throw new Error('elevated setup environment activation is only valid on Windows');
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || stateDirectory.includes('\0')) {
    throw new TypeError('elevated setup environment activation state directory is invalid');
  }
  if (typeof invoke !== 'function' || typeof recordReader !== 'function' || typeof configurationFactory !== 'function'
      || typeof hostInspector !== 'function' || typeof planFactory !== 'function'
      || typeof operatorFactory !== 'function' || typeof activationReconciler !== 'function') {
    throw new TypeError('elevated setup environment activation composition is invalid');
  }

  const host = await hostInspector({ invoke, environment });
  if (host?.elevated !== true) {
    return result({ ready: false, blocker: 'initial environment activation requires the bounded elevated setup child' });
  }
  const plan = planFactory({
    stateDirectory,
    programDataDirectory: host.programData,
    operatorSid: host.operatorSid,
  });
  if (typeof plan?.authorityDirectory !== 'string' || plan.authorityDirectory.length === 0) {
    throw new Error('elevated setup lifecycle authority plan is invalid');
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

  const client = await operatorFactory({
    stateDirectory,
    authorityDirectory: plan.authorityDirectory,
    platform: 'win32',
    invoke,
  });
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
