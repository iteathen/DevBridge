import path from 'node:path';
import {
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from './linux-lifecycle-authority.js';
import {
  normalizeLinuxLifecycleAuthorityOwnershipRecord,
} from './linux-lifecycle-authority-records.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-identity-binding-v2';
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const MAX_LOCAL_ID = 0xffff_fffe;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function localName(value, name) {
  if (typeof value !== 'string' || !LOCAL_NAME.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function numeric(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LOCAL_ID) throw new TypeError(`${name} is invalid`);
  return value;
}

function absoluteLinuxPath(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096 || /[\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value) {
    throw new TypeError(`${name} must be a normalized absolute Linux path`);
  }
  return value;
}

function exactPlan(value) {
  if (!value || value.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL || !value.service || !value.service.account) {
    throw new TypeError('Linux lifecycle authority identity plan is invalid');
  }
  const selected = Object.freeze({
    serviceAccount: localName(value.service.user, 'Linux lifecycle authority service account'),
    operatorAccount: localName(value.service.operator, 'Linux lifecycle authority operator account'),
    readGroup: localName(value.service.readGroup, 'Linux lifecycle authority read group'),
    coordinationGroup: localName(value.service.coordinationGroup, 'Linux lifecycle authority coordination group'),
    requiredGroup: Object.freeze({
      name: localName(value.service.managementGroup, 'Linux lifecycle authority management group'),
      id: numeric(value.service.managementGroupId, 'Linux lifecycle authority management group id'),
    }),
    home: absoluteLinuxPath(value.service.account.home, 'Linux lifecycle authority service home'),
    shell: absoluteLinuxPath(value.service.account.shell, 'Linux lifecycle authority service shell'),
  });
  if (value.service.account.system !== true
      || selected.serviceAccount === selected.operatorAccount
      || new Set([selected.readGroup, selected.coordinationGroup, selected.requiredGroup.name]).size !== 3) {
    throw new TypeError('Linux lifecycle authority identity plan aliases or widens local identity');
  }
  return Object.freeze({ plan: value, selected });
}

function numericIdentity(value, name) {
  exactKeys(value, new Set(['serviceUid', 'operatorUid', 'readGid', 'coordinationGid', 'managementGid']), name);
  const selected = Object.freeze({
    serviceUid: value.serviceUid,
    operatorUid: value.operatorUid,
    readGid: value.readGid,
    coordinationGid: value.coordinationGid,
    managementGid: value.managementGid,
  });
  for (const [key, identity] of Object.entries(selected)) {
    if (!Number.isSafeInteger(identity) || identity < 1) throw new TypeError(`${name} ${key} is invalid`);
  }
  if (selected.serviceUid === selected.operatorUid
      || new Set([selected.readGid, selected.coordinationGid, selected.managementGid]).size !== 3) {
    throw new TypeError(`${name} groups alias`);
  }
  return selected;
}

function sameIdentity(left, right) {
  return left?.serviceUid === right?.serviceUid
    && left?.operatorUid === right?.operatorUid
    && left?.readGid === right?.readGid
    && left?.coordinationGid === right?.coordinationGid
    && left?.managementGid === right?.managementGid;
}

function requirePorts(value) {
  exactKeys(value, new Set(['state', 'reconcile']), 'Linux lifecycle authority identity ports');
  exactKeys(value.state, new Set(['load', 'save']), 'Linux lifecycle authority identity state port');
  for (const [name, port] of Object.entries({ load: value.state.load, save: value.state.save, reconcile: value.reconcile })) {
    if (typeof port !== 'function') throw new TypeError(`Linux lifecycle authority identity ${name} port is invalid`);
  }
  return value;
}

function reconciliationEvidence(value) {
  exactKeys(value, new Set(['applicable', 'changed', 'identity']), 'Linux lifecycle authority identity reconciliation evidence');
  if (value.applicable !== true || typeof value.changed !== 'boolean') {
    throw new Error('Linux lifecycle authority identity reconciliation is not applicable or exact');
  }
  return Object.freeze({ applicable: true, changed: value.changed, identity: numericIdentity(value.identity, 'Linux lifecycle authority reconciled identity') });
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function bindLinuxLifecycleAuthorityIdentity(value = {}, providedPorts) {
  exactKeys(value, new Set(['plan']), 'Linux lifecycle authority identity binding');
  const { plan, selected } = exactPlan(value.plan);
  const ports = requirePorts(providedPorts);
  const loaded = await ports.state.load();
  if (loaded == null) throw new Error('Linux lifecycle authority identity binding requires an established ownership claim');
  const current = normalizeLinuxLifecycleAuthorityOwnershipRecord(loaded, plan);
  if (current.localIdentity != null && current.localIdentity.managementGid !== selected.requiredGroup.id) {
    throw new Error('Linux lifecycle authority required group changed its immutable binding');
  }
  const evidence = reconciliationEvidence(await ports.reconcile(Object.freeze({
    serviceAccount: selected.serviceAccount,
    operatorAccount: selected.operatorAccount,
    readGroup: selected.readGroup,
    coordinationGroup: selected.coordinationGroup,
    requiredGroup: selected.requiredGroup,
    home: selected.home,
    shell: selected.shell,
    claimEstablished: true,
    expectedIdentity: current.localIdentity,
  })));
  if (evidence.identity.managementGid !== selected.requiredGroup.id) {
    throw new Error('Linux lifecycle authority reconciliation returned a different required group');
  }
  if (current.localIdentity != null) {
    if (!sameIdentity(current.localIdentity, evidence.identity)) {
      throw new Error('Linux lifecycle authority reconciled identity changed its immutable binding');
    }
    return Object.freeze({ protocol: PROTOCOL, changed: evidence.changed, identity: current.localIdentity });
  }

  const target = normalizeLinuxLifecycleAuthorityOwnershipRecord({ ...current, localIdentity: evidence.identity }, plan);
  const saved = normalizeLinuxLifecycleAuthorityOwnershipRecord(await ports.state.save(target), plan);
  if (!sameRecord(saved, target)) throw new Error('Linux lifecycle authority identity binding record is not exact');
  return Object.freeze({ protocol: PROTOCOL, changed: true, identity: saved.localIdentity });
}

export { PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_IDENTITY_BINDING_PROTOCOL };
