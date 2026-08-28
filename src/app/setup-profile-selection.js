import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SetupAuthorityManager } from '../runtime/setup-authority.js';
import { createSetupAuthorityStateStore } from '../state/setup-authority-state-store.js';
import { resolveSetupProfileSelection } from '../setup/profile-selection.js';

const PROTOCOL = 'devbridge/setup-profile-selection-status-v1';
const OPERATION_PREFIX = 'profile-selection-';
const DEFAULT_PROFILES = Object.freeze(['linux-development']);
const PROFILE_CHOICES = Object.freeze({
  linux: Object.freeze(['linux-development']),
  windows: Object.freeze(['windows-development']),
  both: Object.freeze(['linux-development', 'windows-development']),
  none: Object.freeze([]),
});

function sameProfiles(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function status({ state, revision, changed, profiles, pendingProfiles = null, source }) {
  return Object.freeze({
    protocol: PROTOCOL,
    state,
    revision,
    changed,
    profiles: Object.freeze([...profiles]),
    pendingProfiles: pendingProfiles == null ? null : Object.freeze([...pendingProfiles]),
    source,
  });
}

export async function reconcileSetupProfileSelection({
  stateDirectory,
  choice = null,
} = {}, {
  storeFactory = createSetupAuthorityStateStore,
  managerFactory = (options) => new SetupAuthorityManager(options),
  now,
  id = randomUUID,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || stateDirectory.includes('\0') || !path.isAbsolute(stateDirectory)) {
    throw new TypeError('setup profile selection state directory is invalid');
  }
  if (typeof storeFactory !== 'function' || typeof managerFactory !== 'function' || typeof id !== 'function') throw new TypeError('setup profile selection dependencies are incomplete');
  const port = storeFactory(path.join(path.resolve(stateDirectory), 'setup-authority.json'));
  const manager = managerFactory({ port, now, id: () => `${OPERATION_PREFIX}${id()}` });
  if (!manager || ['current', 'begin', 'replaceProfiles', 'markValidation', 'commit'].some((name) => typeof manager[name] !== 'function')) {
    throw new TypeError('setup profile selection transaction port is incomplete');
  }

  const current = await manager.current();
  const foreignWorking = current?.working && !current.working.operationId.startsWith(OPERATION_PREFIX);
  if (foreignWorking && choice != null) {
    throw new Error('setup authority has an interrupted transaction owned by another setup component');
  }
  if (foreignWorking) {
    if (!current.accepted) throw new Error('accepted setup profile selection is unavailable during another component transaction');
    return status({
      state: 'accepted',
      revision: current.revision,
      changed: false,
      profiles: current.accepted.requestedProfiles,
      source: 'accepted',
    });
  }
  const decision = resolveSetupProfileSelection({
    choice,
    acceptedProfiles: current?.accepted?.requestedProfiles ?? null,
    workingProfiles: current?.working?.snapshot?.requestedProfiles ?? null,
  }, {
    defaultProfiles: DEFAULT_PROFILES,
    choices: PROFILE_CHOICES,
  });

  if (decision.state === 'deferred') {
    return status({
      state: 'deferred',
      revision: current?.revision ?? 0,
      changed: false,
      profiles: decision.profiles,
      pendingProfiles: decision.pendingProfiles,
      source: decision.source,
    });
  }
  if (!current?.working && current?.accepted && sameProfiles(current.accepted.requestedProfiles, decision.profiles)) {
    return status({
      state: 'accepted',
      revision: current.revision,
      changed: false,
      profiles: decision.profiles,
      source: decision.source,
    });
  }

  let record = current;
  if (!record?.working) {
    const started = await manager.begin();
    if (started.resumed) throw new Error('setup authority changed while starting profile selection; retry');
    record = started.record;
  }
  if (!record.working.operationId.startsWith(OPERATION_PREFIX)) {
    throw new Error('setup authority has an interrupted transaction owned by another setup component');
  }
  const operationId = record.working.operationId;
  record = await manager.replaceProfiles(operationId, { requestedProfiles: decision.profiles });
  record = await manager.markValidation(operationId, 'passed');
  record = await manager.commit(operationId);
  return status({
    state: 'accepted',
    revision: record.revision,
    changed: true,
    profiles: record.accepted.requestedProfiles,
    source: decision.source,
  });
}
