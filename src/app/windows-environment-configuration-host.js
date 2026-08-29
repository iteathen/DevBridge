import process from 'node:process';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createEnvironmentLifecycle } from './environment-lifecycle.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { reconcileEnvironmentProfileConfiguration } from '../runtime/environment-profile-configuration.js';
import { readEnvironmentProfileConfigurationRecord } from '../setup/environment-profile-configuration-record.js';
import { reconcileWindowsLifecycleAuthorityImages } from '../setup/windows-lifecycle-authority-image-adoption.js';
import { assertSetupResourceConflictPort, normalizeSetupResourceConflictObservation } from '../setup/resource-conflict.js';
import { createSetupResourceConflictConsentStore } from '../state/setup-resource-conflict-consent-store.js';
import { createWindowsSetupResourceConflict } from '../setup/windows-resource-conflict.js';

const EXPECTED_KEYS = new Set(['revision', 'subject']);

function directory(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is invalid`);
  return value;
}

function expected(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('protected environment configuration subject is invalid');
  for (const key of Object.keys(raw)) if (!EXPECTED_KEYS.has(key)) throw new TypeError(`protected environment configuration subject.${key} is not allowed`);
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1 || typeof raw.subject !== 'string' || !/^[0-9a-f]{64}$/u.test(raw.subject)) {
    throw new TypeError('protected environment configuration subject is invalid');
  }
  return Object.freeze({ revision: raw.revision, subject: raw.subject });
}

function exactRecord(record, selected) {
  if (record == null || record.revision !== selected.revision || record.digest !== selected.subject) {
    throw new Error('accepted environment profile configuration subject changed');
  }
  return record;
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

  return Object.freeze({
    async inspect() { return Object.freeze({ ready: true }); },
    async reconcile(raw) {
      const selected = expected(raw);
      const record = exactRecord(await recordReader({ stateDirectory: ordinary }), selected);
      if (record.configuration.declarations.length === 0) {
        return Object.freeze({ ready: true, changed: false, revision: selected.revision, subject: selected.subject });
      }

      await adoptImages({ stateDirectory: ordinary, authorityDirectory: authority, platform, invoke });
      const foundation = await foundationFactory({ stateDirectory: authority, platform, invoke });
      const before = await foundation.inspect();
      if (before?.capabilities?.management?.ready !== true) throw new Error('protected environment management is unavailable');

      const conflict = assertSetupResourceConflictPort(conflictFactory({ identity: before.identity, platform, invoke }));
      const observedConflict = normalizeSetupResourceConflictObservation(await conflict.inspect());
      let conflictChanged = false;
      if (observedConflict.state === 'blocked') throw new Error(observedConflict.reason);
      if (observedConflict.state === 'approval-required') {
        const consent = await consentStoreFactory({ stateDirectory: ordinary }).load();
        if (consent?.subject !== observedConflict.subject) throw new Error('local resource conflict requires exact operator consent');
        const retired = await conflict.retire(consent);
        if (retired?.ready !== true) throw new Error(retired?.reason ?? 'approved local resource conflict did not retire');
        conflictChanged = retired.changed === true;
      }

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

      const lifecycle = lifecycleFactory({ stateDirectory: authority });
      const reconciled = await reconcileEnvironmentProfileConfiguration(record, {
        declarations: lifecycle.declarations,
        images: Object.freeze({
          list: () => foundation.listImages(),
          verify: (identity) => foundation.verifyImage(identity),
        }),
      });
      if (reconciled.ready !== true || reconciled.configurationRevision !== selected.revision || reconciled.configurationDigest !== selected.subject) {
        throw new Error('protected environment configuration result changed subject');
      }
      exactRecord(await recordReader({ stateDirectory: ordinary }), selected);
      const resourcesChanged = conflictChanged || before.capabilities.storage?.ready !== true || before.capabilities.networking?.ready !== true;
      return Object.freeze({
        ready: true,
        changed: reconciled.changed || resourcesChanged,
        revision: selected.revision,
        subject: selected.subject,
      });
    },
  });
}
