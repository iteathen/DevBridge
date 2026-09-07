import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SetupAuthorityManager } from '../runtime/setup-authority.js';
import { createImmutableSubjectRecordStateStore } from '../state/immutable-subject-record-state-store.js';
import { createSetupAuthorityStateStore } from '../state/setup-authority-state-store.js';
import {
  createConfigureLaterWindowsActivationPolicy,
  normalizeWindowsActivationPolicy,
  windowsActivationPolicySubject,
} from '../setup/windows-activation-policy.js';

const PROTOCOL = 'devbridge/setup-windows-activation-policy-status-v1';
const OPERATION_PREFIX = 'activation-policy-configure-later-';
const PROFILE = 'windows-development';
const AUTHORITY_CLASS = 'activation';

function status({ state, changed = false, mode = null, blocker = null }) {
  return Object.freeze({
    protocol: PROTOCOL,
    state,
    ready: state === 'accepted',
    changed,
    mode,
    activationRequired: true,
    blocker,
  });
}

function activationAuthority(snapshot) {
  if (!snapshot?.requestedProfiles?.includes(PROFILE)) throw new Error('selected setup authority does not contain the required profile');
  const authority = snapshot.authorities.find((entry) => entry.profile === PROFILE && entry.class === AUTHORITY_CLASS);
  if (!authority) throw new Error('selected setup authority does not contain the required policy class');
  return authority;
}

function selectionRequired(authority) {
  return authority.subjectRef == null
    && authority.approval === 'unapproved'
    && authority.availability === 'unknown';
}

async function observeAccepted(record, store, expectedPolicy, expectedSubject) {
  const authority = activationAuthority(record.accepted);
  if (selectionRequired(authority)) {
    return status({
      state: 'selection-required',
      blocker: 'Windows activation policy requires an explicit local selection',
    });
  }
  if (authority.requirement !== 'required'
      || authority.approval !== 'approved'
      || authority.availability !== 'available'
      || authority.provenance !== 'manual'
      || authority.subjectRef !== expectedSubject) {
    return status({ state: 'blocked', blocker: 'accepted Windows activation policy authority is invalid' });
  }
  const stored = await store.load(expectedSubject);
  if (stored == null) return status({ state: 'blocked', blocker: 'accepted Windows activation policy record is unavailable' });
  try {
    const observed = normalizeWindowsActivationPolicy(stored);
    if (windowsActivationPolicySubject(observed) !== expectedSubject
        || JSON.stringify(observed) !== JSON.stringify(expectedPolicy)) {
      return status({ state: 'blocked', blocker: 'accepted Windows activation policy record does not match its authority' });
    }
  } catch {
    return status({ state: 'blocked', blocker: 'accepted Windows activation policy record is invalid' });
  }
  return status({ state: 'accepted', mode: expectedPolicy.mode });
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

export async function reconcileSetupWindowsActivationPolicy({
  stateDirectory,
  choice = null,
} = {}, {
  storeFactory = createImmutableSubjectRecordStateStore,
  managerFactory = (options) => new SetupAuthorityManager(options),
  now,
  id = randomUUID,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || stateDirectory.includes('\0') || !path.isAbsolute(stateDirectory)) {
    throw new TypeError('activation policy state directory is invalid');
  }
  if (choice != null && choice !== 'later') throw new TypeError('activation policy choice is unsupported');
  if (typeof storeFactory !== 'function' || typeof managerFactory !== 'function' || typeof id !== 'function') {
    throw new TypeError('activation policy dependencies are incomplete');
  }

  const store = requirePort(
    storeFactory(path.join(path.resolve(stateDirectory), 'windows-activation-policies.json')),
    ['load', 'save'],
    'activation policy state',
  );
  const manager = requirePort(
    managerFactory({
      port: createSetupAuthorityStateStore(path.join(path.resolve(stateDirectory), 'setup-authority.json')),
      now,
      id: () => `${OPERATION_PREFIX}${id()}`,
    }),
    ['current', 'begin', 'replaceAuthority', 'markValidation', 'commit'],
    'setup authority transaction',
  );
  const expectedPolicy = createConfigureLaterWindowsActivationPolicy();
  const expectedSubject = windowsActivationPolicySubject(expectedPolicy);
  const current = await manager.current();
  if (!current?.accepted) throw new Error('accepted setup authority is unavailable');
  if (current.working && !current.working.operationId.startsWith(OPERATION_PREFIX)) {
    if (choice != null) throw new Error('setup authority has an interrupted transaction owned by another setup component');
    return observeAccepted(current, store, expectedPolicy, expectedSubject);
  }

  if (!current.working) {
    const observed = await observeAccepted(current, store, expectedPolicy, expectedSubject);
    if (observed.state !== 'selection-required' || choice == null) return observed;
  }

  let record = current;
  if (!record.working) {
    const started = await manager.begin();
    if (started.resumed) throw new Error('setup authority changed while starting activation policy; retry');
    record = started.record;
  }
  if (!record.working.operationId.startsWith(OPERATION_PREFIX)) {
    throw new Error('setup authority has an interrupted transaction owned by another setup component');
  }
  const operationId = record.working.operationId;
  let authority = activationAuthority(record.working.snapshot);
  if (authority.subjectRef == null) {
    record = await manager.replaceAuthority(operationId, {
      ...authority,
      requirement: 'required',
      approval: 'approved',
      availability: 'unknown',
      subjectRef: expectedSubject,
      provenance: 'manual',
    });
    authority = activationAuthority(record.working.snapshot);
  } else if (authority.requirement !== 'required'
      || authority.approval !== 'approved'
      || !['unknown', 'available'].includes(authority.availability)
      || authority.provenance !== 'manual'
      || authority.subjectRef !== expectedSubject) {
    throw new Error('interrupted activation policy transaction does not match its recoverable intent');
  }

  await store.save(expectedSubject, expectedPolicy);
  const published = normalizeWindowsActivationPolicy(await store.load(expectedSubject));
  if (windowsActivationPolicySubject(published) !== expectedSubject
      || JSON.stringify(published) !== JSON.stringify(expectedPolicy)) {
    throw new Error('published activation policy did not re-observe with its exact identity');
  }
  if (authority.availability !== 'available') {
    record = await manager.replaceAuthority(operationId, { ...authority, availability: 'available' });
  }
  if (record.working.validation !== 'passed') record = await manager.markValidation(operationId, 'passed');
  record = await manager.commit(operationId);
  const accepted = await observeAccepted(record, store, expectedPolicy, expectedSubject);
  if (accepted.state !== 'accepted') throw new Error(accepted.blocker);
  return status({ state: 'accepted', changed: true, mode: expectedPolicy.mode });
}
