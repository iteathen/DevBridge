import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createEnvironmentFoundation } from '../app/environment-foundation.js';
import { createEnvironmentLifecycle } from '../app/environment-lifecycle.js';
import { createConfiguredEnvironmentActivityClient } from '../runtime/environment-activity-authority-transport.js';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_MAX_BYTES,
  inspectEnvironmentProfileConfiguration,
  normalizeEnvironmentProfileConfigurationRecord,
  reconcileEnvironmentProfileConfiguration,
} from '../runtime/environment-profile-configuration.js';
import { ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY } from '../state/environment-profile-configuration-state-store.js';
import { reconcileWindowsLifecycleAuthorityImages } from './windows-lifecycle-authority-image-adoption.js';
import { WINDOWS_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL } from './windows-lifecycle-authority.js';

const MAX_STATE_BYTES = ENVIRONMENT_PROFILE_CONFIGURATION_MAX_BYTES + 64 * 1024;

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function boundedAcceptedRecord(stateDirectory) {
  const root = path.resolve(stateDirectory);
  const directory = path.join(root, 'environment-profile-configuration');
  const file = path.join(directory, 'state.json');
  let values;
  try { values = await Promise.all([lstat(root), lstat(directory), lstat(file)]); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!values[0].isDirectory() || values[0].isSymbolicLink()
      || !values[1].isDirectory() || values[1].isSymbolicLink()
      || !values[2].isFile() || values[2].isSymbolicLink()
      || values[2].size < 2 || values[2].size > MAX_STATE_BYTES) {
    throw new Error('accepted environment profile configuration is not one bounded real file');
  }
  const [canonicalRoot, canonicalDirectory, canonicalFile] = await Promise.all([realpath(root), realpath(directory), realpath(file)]);
  if (!inside(canonicalRoot, canonicalDirectory) || !inside(canonicalRoot, canonicalFile) || path.dirname(canonicalFile) !== canonicalDirectory) {
    throw new Error('accepted environment profile configuration escaped its state boundary');
  }
  const document = JSON.parse(await readFile(canonicalFile, 'utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('accepted environment profile configuration state is invalid');
  const raw = document[ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY];
  return raw == null ? null : normalizeEnvironmentProfileConfigurationRecord(raw);
}

function configurationResult({ ready, changed = false, blocker = null }) {
  return Object.freeze({ ready, changed, blocker });
}

export function createWindowsEnvironmentProfileConfiguration({
  stateDirectory,
  platform = process.platform,
  invoke,
} = {}, {
  adoptImages = reconcileWindowsLifecycleAuthorityImages,
  foundationFactory = createEnvironmentFoundation,
  lifecycleFactory = createEnvironmentLifecycle,
  activityFactory = createConfiguredEnvironmentActivityClient,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment profile setup stateDirectory is required');
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('environment profile setup platform is invalid');
  if (invoke != null && typeof invoke !== 'function') throw new TypeError('environment profile setup invocation contract is invalid');
  if (typeof adoptImages !== 'function' || typeof foundationFactory !== 'function' || typeof lifecycleFactory !== 'function'
      || typeof activityFactory !== 'function') {
    throw new TypeError('environment profile setup composition is incomplete');
  }
  return Object.freeze({
    async inspect({ client } = {}) {
      if (platform !== 'win32') return configurationResult({ ready: true });
      if (!client || typeof client.list !== 'function') throw new TypeError('environment profile setup observation contract is incomplete');
      const record = await boundedAcceptedRecord(stateDirectory);
      if (record == null || record.configuration.declarations.length === 0) return configurationResult({ ready: true });
      try {
        const [declarations, resources] = await Promise.all([
          client.list(),
          activityFactory({ stateDirectory, platform: 'win32', connectTimeoutMs: 3_000 }).inspect(),
        ]);
        const result = inspectEnvironmentProfileConfiguration(record, declarations);
        if (!result.ready) return configurationResult({ ready: false, blocker: result.blocker });
        if (resources?.ready !== true) {
          return configurationResult({ ready: false, blocker: 'protected environment resources do not match accepted profile requirements' });
        }
        return configurationResult({ ready: true });
      } catch {
        return configurationResult({ ready: false, blocker: 'protected profile state could not be verified against accepted configuration' });
      }
    },

    async reconcile({ plan } = {}) {
      if (platform !== 'win32') return configurationResult({ ready: true });
      if (!plan || plan.protocol !== WINDOWS_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL || typeof plan.authorityDirectory !== 'string'
          || typeof plan.stateDirectory !== 'string'
          || plan.stateDirectory.toLowerCase() !== path.win32.resolve(stateDirectory).toLowerCase()) {
        throw new TypeError('environment profile setup authority plan is invalid');
      }
      const record = await boundedAcceptedRecord(stateDirectory);
      if (record == null || record.configuration.declarations.length === 0) return configurationResult({ ready: true });
      await adoptImages({
        stateDirectory: plan.stateDirectory,
        authorityDirectory: plan.authorityDirectory,
        platform,
        ...(invoke ? { invoke } : {}),
      });
      const foundation = await foundationFactory({
        stateDirectory: plan.authorityDirectory,
        platform,
        ...(invoke ? { invoke } : {}),
      });
      const before = await foundation.inspect();
      if (before?.capabilities?.management?.ready !== true) throw new Error('protected environment management is unavailable');
      const storage = await foundation.ensureStorage();
      if (storage?.ready !== true) throw new Error('protected environment storage did not reconcile');
      const network = await foundation.ensureNetwork();
      if (network?.ready !== true) throw new Error('protected environment networking did not reconcile');
      const after = await foundation.inspect();
      if (after?.identity !== before.identity
          || after?.capabilities?.management?.ready !== true
          || after?.capabilities?.storage?.ready !== true
          || after?.capabilities?.networking?.ready !== true) {
        throw new Error('protected environment resources did not verify after reconciliation');
      }
      const lifecycle = lifecycleFactory({ stateDirectory: plan.authorityDirectory });
      const result = await reconcileEnvironmentProfileConfiguration(record, {
        declarations: lifecycle.declarations,
        images: Object.freeze({
          list: () => foundation.listImages(),
          verify: (identity) => foundation.verifyImage(identity),
        }),
      });
      const resourcesChanged = before.capabilities.storage?.ready !== true || before.capabilities.networking?.ready !== true;
      return configurationResult({ ready: result.ready, changed: result.changed || resourcesChanged });
    },
  });
}
