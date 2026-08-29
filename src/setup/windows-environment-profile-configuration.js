import process from 'node:process';
import { createConfiguredEnvironmentActivityClient } from '../runtime/environment-activity-authority-transport.js';
import { createConfiguredEnvironmentConfigurationClient } from '../runtime/environment-configuration-authority-transport.js';
import { inspectEnvironmentProfileConfiguration } from '../runtime/environment-profile-configuration.js';
import { readEnvironmentProfileConfigurationRecord } from './environment-profile-configuration-record.js';

function result({ ready, changed = false, blocker = null }) {
  return Object.freeze({ ready, changed, blocker });
}

function lifecycle(value) {
  if (!value || typeof value.list !== 'function') throw new TypeError('environment profile setup observation contract is incomplete');
  return value;
}

function configuration(value) {
  if (!value || typeof value.reconcile !== 'function') throw new TypeError('environment profile setup configuration contract is incomplete');
  return value;
}

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

  const accepted = () => recordReader({ stateDirectory });

  return Object.freeze({
    async inspect({ client } = {}) {
      if (platform !== 'win32') return result({ ready: true });
      const selected = lifecycle(client);
      const record = await accepted();
      if (record == null || record.configuration.declarations.length === 0) return result({ ready: true });
      try {
        const [declarations, resources] = await Promise.all([
          selected.list(),
          activityFactory({ stateDirectory, platform: 'win32', connectTimeoutMs: 3_000 }).inspect(),
        ]);
        const inspected = inspectEnvironmentProfileConfiguration(record, declarations);
        if (!inspected.ready) return result({ ready: false, blocker: inspected.blocker });
        if (resources?.ready !== true) return result({ ready: false, blocker: 'protected environment resources do not match accepted profile requirements' });
        return result({ ready: true });
      } catch {
        return result({ ready: false, blocker: 'protected profile state could not be verified against accepted configuration' });
      }
    },

    async reconcile() {
      if (platform !== 'win32') return result({ ready: true });
      const record = await accepted();
      if (record == null || record.configuration.declarations.length === 0) return result({ ready: true });
      const client = configuration(configurationFactory({ stateDirectory, platform: 'win32', connectTimeoutMs: 3_000 }));
      const reconciled = await client.reconcile({ revision: record.revision, subject: record.digest });
      if (reconciled?.ready !== true || reconciled.revision !== record.revision || reconciled.subject !== record.digest
          || typeof reconciled.changed !== 'boolean') {
        throw new Error('protected environment configuration evidence changed');
      }
      return result({ ready: true, changed: reconciled.changed });
    },
  });
}
