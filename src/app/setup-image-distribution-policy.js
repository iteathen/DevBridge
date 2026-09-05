import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { SetupAuthorityManager } from '../runtime/setup-authority.js';
import { createImmutableSubjectRecordStateStore } from '../state/immutable-subject-record-state-store.js';
import { createSetupAuthorityStateStore } from '../state/setup-authority-state-store.js';
import {
  createLocalReconstructionImageDistributionPolicy,
  imageDistributionPolicySubject,
  normalizeImageDistributionPolicy,
} from '../setup/image-distribution-policy.js';

const PROTOCOL = 'devbridge/setup-image-distribution-policy-status-v1';
const AUTHORITY_CLASS = 'distribution';
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;

function operationPrefix(profile) {
  const digest = createHash('sha256').update(profile, 'utf8').digest('hex').slice(0, 32);
  return `distribution-policy-${digest}-`;
}

function status({ state, changed = false, mode = null, blocker = null }) {
  return Object.freeze({
    protocol: PROTOCOL,
    state,
    ready: state === 'accepted',
    changed,
    mode,
    blocker,
  });
}

function distributionAuthority(snapshot, profile) {
  if (!snapshot?.requestedProfiles?.includes(profile)) throw new Error('selected setup authority does not contain the required profile');
  const authority = snapshot.authorities.find((entry) => entry.profile === profile && entry.class === AUTHORITY_CLASS);
  if (!authority) throw new Error('selected setup authority does not contain the required policy class');
  return authority;
}

function selectionRequired(authority) {
  return authority.subjectRef == null
    && authority.approval === 'unapproved'
    && authority.availability === 'unknown';
}

async function observeAccepted(record, store, profile) {
  const authority = distributionAuthority(record.accepted, profile);
  if (selectionRequired(authority)) {
    return status({
      state: 'selection-required',
      blocker: 'Image distribution policy requires an explicit local selection',
    });
  }
  if (authority.requirement !== 'required'
      || authority.approval !== 'approved'
      || authority.availability !== 'available'
      || authority.provenance !== 'manual'
      || authority.subjectRef == null) {
    return status({ state: 'blocked', blocker: 'Accepted image distribution policy authority is invalid' });
  }
  const stored = await store.load(authority.subjectRef);
  if (stored == null) return status({ state: 'blocked', blocker: 'Accepted image distribution policy record is unavailable' });
  try {
    const observed = normalizeImageDistributionPolicy(stored);
    if (imageDistributionPolicySubject(observed) !== authority.subjectRef) {
      return status({ state: 'blocked', blocker: 'Accepted image distribution policy record does not match its authority' });
    }
    return status({ state: 'accepted', mode: observed.mode });
  } catch {
    return status({ state: 'blocked', blocker: 'Accepted image distribution policy record is invalid' });
  }
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

export async function reconcileSetupImageDistributionPolicy({
  stateDirectory,
  profile,
  choice = null,
} = {}, {
  storeFactory = createImmutableSubjectRecordStateStore,
  managerFactory = (options) => new SetupAuthorityManager(options),
  now,
  id = randomUUID,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || stateDirectory.includes('\0') || !path.isAbsolute(stateDirectory)) {
    throw new TypeError('image distribution policy state directory is invalid');
  }
  if (typeof profile !== 'string' || !SAFE_PROFILE.test(profile)) throw new TypeError('image distribution policy profile is invalid');
  if (choice != null && choice !== 'local-reconstruction') throw new TypeError('image distribution policy choice is unsupported');
  if (typeof storeFactory !== 'function' || typeof managerFactory !== 'function' || typeof id !== 'function') {
    throw new TypeError('image distribution policy dependencies are incomplete');
  }

  const store = requirePort(
    storeFactory(path.join(path.resolve(stateDirectory), 'image-distribution-policies.json')),
    ['load', 'save'],
    'image distribution policy state',
  );
  const prefix = operationPrefix(profile);
  const manager = requirePort(
    managerFactory({
      port: createSetupAuthorityStateStore(path.join(path.resolve(stateDirectory), 'setup-authority.json')),
      now,
      id: () => `${prefix}${id()}`,
    }),
    ['current', 'begin', 'replaceAuthority', 'markValidation', 'commit'],
    'setup authority transaction',
  );
  const expectedPolicy = createLocalReconstructionImageDistributionPolicy();
  const expectedSubject = imageDistributionPolicySubject(expectedPolicy);
  const current = await manager.current();
  if (!current?.accepted) throw new Error('accepted setup authority is unavailable');
  if (current.working && !current.working.operationId.startsWith(prefix)) {
    if (choice != null) throw new Error('setup authority has an interrupted transaction owned by another setup component');
    return observeAccepted(current, store, profile);
  }

  if (!current.working) {
    const observed = await observeAccepted(current, store, profile);
    if (choice == null || (observed.state === 'accepted' && observed.mode === expectedPolicy.mode)) return observed;
  }

  let record = current;
  if (!record.working) {
    const started = await manager.begin();
    if (started.resumed) throw new Error('setup authority changed while starting image distribution policy; retry');
    record = started.record;
  }
  if (!record.working.operationId.startsWith(prefix)) {
    throw new Error('setup authority has an interrupted transaction owned by another setup component');
  }
  const operationId = record.working.operationId;
  let authority = distributionAuthority(record.working.snapshot, profile);
  if (authority.subjectRef == null) {
    record = await manager.replaceAuthority(operationId, {
      ...authority,
      requirement: 'required',
      approval: 'approved',
      availability: 'unknown',
      subjectRef: expectedSubject,
      provenance: 'manual',
    });
    authority = distributionAuthority(record.working.snapshot, profile);
  } else if (authority.requirement !== 'required'
      || authority.approval !== 'approved'
      || !['unknown', 'available'].includes(authority.availability)
      || authority.provenance !== 'manual'
      || authority.subjectRef !== expectedSubject) {
    throw new Error('interrupted image distribution policy transaction does not match its recoverable intent');
  }

  await store.save(expectedSubject, expectedPolicy);
  const published = normalizeImageDistributionPolicy(await store.load(expectedSubject));
  if (imageDistributionPolicySubject(published) !== expectedSubject
      || JSON.stringify(published) !== JSON.stringify(expectedPolicy)) {
    throw new Error('published image distribution policy did not re-observe with its exact identity');
  }
  if (authority.availability !== 'available') {
    record = await manager.replaceAuthority(operationId, { ...authority, availability: 'available' });
  }
  if (record.working.validation !== 'passed') record = await manager.markValidation(operationId, 'passed');
  record = await manager.commit(operationId);
  const accepted = await observeAccepted(record, store, profile);
  if (accepted.state !== 'accepted') throw new Error(accepted.blocker);
  return status({ state: 'accepted', changed: true, mode: expectedPolicy.mode });
}
