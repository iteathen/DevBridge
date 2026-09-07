import { reconcileEnvironmentProfileConfiguration } from '../runtime/environment-profile-configuration.js';
import { assertSetupResourceConflictPort, normalizeSetupResourceConflictObservation } from '../setup/resource-conflict.js';

const EXPECTED_KEYS = new Set(['revision', 'subject']);

function port(value, name, methods) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

function functionPort(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} port is invalid`);
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

export function createProtectedEnvironmentConfiguration({
  readAccepted,
  prepare = async () => Object.freeze({ ready: true, changed: false }),
  createFoundation,
  createLifecycle,
  createConflict,
  readConsent = async () => null,
} = {}) {
  const load = functionPort(readAccepted, 'protected environment configuration accepted-state');
  const prepareLocal = functionPort(prepare, 'protected environment configuration preparation');
  const foundationFactory = functionPort(createFoundation, 'protected environment configuration foundation');
  const lifecycleFactory = functionPort(createLifecycle, 'protected environment configuration lifecycle');
  const conflictFactory = functionPort(createConflict, 'protected environment configuration conflict');
  const consentReader = functionPort(readConsent, 'protected environment configuration consent');

  return Object.freeze({
    async inspect() { return Object.freeze({ ready: true }); },
    async reconcile(raw) {
      const selected = expected(raw);
      const record = exactRecord(await load(), selected);
      if (record.configuration.declarations.length === 0) {
        exactRecord(await load(), selected);
        return Object.freeze({ ready: true, changed: false, revision: selected.revision, subject: selected.subject });
      }

      const prepared = await prepareLocal();
      if (prepared?.ready !== true || typeof prepared.changed !== 'boolean') throw new Error('protected environment preparation did not reconcile');
      const foundation = port(await foundationFactory(), 'protected environment foundation', ['inspect']);
      const before = await foundation.inspect();
      if (before?.capabilities?.management?.ready !== true) throw new Error('protected environment management is unavailable');
      port(foundation, 'protected environment foundation', ['ensureStorage', 'ensureNetwork']);

      const conflict = assertSetupResourceConflictPort(conflictFactory({ identity: before.identity }));
      const observedConflict = normalizeSetupResourceConflictObservation(await conflict.inspect());
      let conflictChanged = false;
      if (observedConflict.state === 'blocked') throw new Error(observedConflict.reason);
      if (observedConflict.state === 'approval-required') {
        const consent = await consentReader();
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
      port(foundation, 'protected environment foundation', ['listImages', 'verifyImage']);

      const lifecycle = createLifecycle();
      if (!lifecycle || typeof lifecycle !== 'object' || lifecycle.declarations == null) {
        throw new TypeError('protected environment lifecycle contract is incomplete');
      }
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
      exactRecord(await load(), selected);
      const resourcesChanged = prepared.changed || conflictChanged
        || before.capabilities.storage?.ready !== true
        || before.capabilities.networking?.ready !== true;
      return Object.freeze({
        ready: true,
        changed: reconciled.changed || resourcesChanged,
        revision: selected.revision,
        subject: selected.subject,
      });
    },
  });
}
