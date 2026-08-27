import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import {
  LINUX_LOCAL_IDENTITIES_PROTOCOL,
  observeLinuxLocalIdentities,
} from './linux-local-identities.js';

const PROTOCOL = 'devbridge/linux-local-identity-reconciliation-v1';
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const ABSOLUTE_PATH = /^\/(?:[^\0\r\n/]+(?:\/|$))*$/u;
const GROUPADD = '/usr/sbin/groupadd';
const USERADD = '/usr/sbin/useradd';
const USERMOD = '/usr/sbin/usermod';

function localName(value, name) {
  if (typeof value !== 'string' || !LOCAL_NAME.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !ABSOLUTE_PATH.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function numeric(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeExpected(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Linux local identity expected binding is invalid');
  const allowed = new Set(['serviceUid', 'readGid', 'coordinationGid', 'managementGid']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError('Linux local identity expected binding contains an unknown field');
  const selected = Object.freeze({
    serviceUid: numeric(value.serviceUid, 'Linux local service uid'),
    readGid: numeric(value.readGid, 'Linux local read gid'),
    coordinationGid: numeric(value.coordinationGid, 'Linux local coordination gid'),
    managementGid: numeric(value.managementGid, 'Linux local management gid'),
  });
  if (new Set([selected.readGid, selected.coordinationGid, selected.managementGid]).size !== 3) {
    throw new TypeError('Linux local identity expected groups alias');
  }
  return selected;
}

function account(observed, name) {
  return observed.accounts.find((entry) => entry.name === name) ?? null;
}

function group(observed, name) {
  return observed.groups.find((entry) => entry.name === name) ?? null;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function succeeded(result) {
  return result?.exitCode === 0
    && result?.timedOut !== true
    && result?.aborted !== true
    && result?.outputTruncated !== true;
}

async function mutate(invoke, environment, executable, argumentsList, label) {
  const result = await invoke({
    executable,
    arguments: argumentsList,
    input: null,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024,
    environment,
  });
  if (!succeeded(result)) throw new Error(`Linux local identity ${label} failed`);
}

function validateObservation(value) {
  if (!value || value.protocol !== LINUX_LOCAL_IDENTITIES_PROTOCOL || value.applicable !== true) {
    throw new Error('Linux local identity observation is invalid');
  }
  return value;
}

function exactBoundIdentity(observed, selected, expected) {
  if (expected == null) return;
  const service = account(observed, selected.serviceAccount)?.record;
  const read = group(observed, selected.readGroup)?.record;
  const coordination = group(observed, selected.coordinationGroup)?.record;
  const management = group(observed, selected.managementGroup)?.record;
  if (service?.uid !== expected.serviceUid
      || read?.gid !== expected.readGid
      || coordination?.gid !== expected.coordinationGid
      || management?.gid !== expected.managementGid) {
    throw new Error('Linux local identity numeric binding changed');
  }
}

function projectIdentity(observed, selected) {
  const service = account(observed, selected.serviceAccount);
  const operator = account(observed, selected.operatorAccount);
  const read = group(observed, selected.readGroup);
  const coordination = group(observed, selected.coordinationGroup);
  const management = group(observed, selected.managementGroup);
  if ([service?.record, operator?.record, read?.record, coordination?.record, management?.record].some((entry) => entry == null)) {
    throw new Error('Linux local identity reconciliation is incomplete');
  }
  if (service.record.uid === 0 || operator.record.uid === 0) throw new Error('Linux local identity unexpectedly has root authority');
  const groupIds = [read.record.gid, coordination.record.gid, management.record.gid];
  if (groupIds.some((value) => value === 0) || new Set(groupIds).size !== groupIds.length) {
    throw new Error('Linux local identity groups are invalid');
  }
  if (service.record.gid !== read.record.gid
      || service.record.home !== selected.home
      || service.record.shell !== selected.shell
      || !sameSet(service.groupIds, groupIds)) {
    throw new Error('Linux local service account contract is not exact');
  }
  if (!operator.groupIds.includes(read.record.gid)
      || !operator.groupIds.includes(coordination.record.gid)
      || operator.groupIds.includes(management.record.gid)) {
    throw new Error('Linux local operator capability contract is not exact');
  }
  return Object.freeze({
    serviceUid: service.record.uid,
    readGid: read.record.gid,
    coordinationGid: coordination.record.gid,
    managementGid: management.record.gid,
  });
}

export async function reconcileLinuxLocalIdentityContract({
  serviceAccount,
  operatorAccount,
  readGroup,
  coordinationGroup,
  managementGroup,
  home,
  shell,
  claimEstablished = false,
  expectedIdentity = null,
  platform = process.platform,
  invoke = invokeCommand,
  environment = process.env,
} = {}, {
  observe = observeLinuxLocalIdentities,
} = {}) {
  if (platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform, applicable: false });
  if (typeof invoke !== 'function' || typeof observe !== 'function') throw new TypeError('Linux local identity reconciliation ports are invalid');
  if (claimEstablished !== true) throw new Error('Linux local identity reconciliation requires an established protected claim');
  const selected = Object.freeze({
    serviceAccount: localName(serviceAccount, 'Linux local service account'),
    operatorAccount: localName(operatorAccount, 'Linux local operator account'),
    readGroup: localName(readGroup, 'Linux local read group'),
    coordinationGroup: localName(coordinationGroup, 'Linux local coordination group'),
    managementGroup: localName(managementGroup, 'Linux local management group'),
    home: absolutePath(home, 'Linux local service home'),
    shell: absolutePath(shell, 'Linux local service shell'),
  });
  if (new Set([selected.serviceAccount, selected.operatorAccount]).size !== 2
      || new Set([selected.readGroup, selected.coordinationGroup, selected.managementGroup]).size !== 3) {
    throw new TypeError('Linux local identity names alias');
  }
  const expected = normalizeExpected(expectedIdentity);
  const observeCurrent = async () => validateObservation(await observe({
    accountNames: [selected.operatorAccount, selected.serviceAccount],
    groupNames: [selected.readGroup, selected.coordinationGroup, selected.managementGroup],
    platform,
    invoke,
    environment,
  }));

  let current = await observeCurrent();
  let changed = false;
  const operator = account(current, selected.operatorAccount);
  if (operator?.record == null || operator.record.uid === 0) throw new Error('Linux local operator account is unavailable');
  exactBoundIdentity(current, selected, expected);

  for (const name of [selected.readGroup, selected.coordinationGroup, selected.managementGroup]) {
    if (group(current, name)?.record == null) {
      if (expected != null) throw new Error('Linux local bound group disappeared');
      await mutate(invoke, environment, GROUPADD, ['--system', '--', name], 'group creation');
      changed = true;
      current = await observeCurrent();
      if (group(current, name)?.record == null) throw new Error('Linux local group creation is not observable');
    }
  }

  const read = group(current, selected.readGroup).record;
  const coordination = group(current, selected.coordinationGroup).record;
  const management = group(current, selected.managementGroup).record;
  if (new Set([read.gid, coordination.gid, management.gid]).size !== 3 || [read.gid, coordination.gid, management.gid].includes(0)) {
    throw new Error('Linux local group identities alias');
  }
  if (account(current, selected.operatorAccount).groupIds.includes(management.gid)) {
    throw new Error('Linux local operator already has management authority');
  }

  let service = account(current, selected.serviceAccount);
  if (service?.record == null) {
    if (expected != null) throw new Error('Linux local bound service account disappeared');
    await mutate(invoke, environment, USERADD, [
      '--system',
      '--gid', selected.readGroup,
      '--groups', `${selected.coordinationGroup},${selected.managementGroup}`,
      '--home-dir', selected.home,
      '--shell', selected.shell,
      '--no-create-home',
      '--no-user-group',
      '--', selected.serviceAccount,
    ], 'service account creation');
    changed = true;
    current = await observeCurrent();
    service = account(current, selected.serviceAccount);
    if (service?.record == null) throw new Error('Linux local service account creation is not observable');
  }
  if (service.record.uid === 0
      || service.record.gid !== read.gid
      || service.record.home !== selected.home
      || service.record.shell !== selected.shell) {
    throw new Error('Linux local service account identity is foreign');
  }
  exactBoundIdentity(current, selected, expected);

  const expectedServiceGroups = [read.gid, coordination.gid, management.gid].sort((left, right) => left - right);
  if (!sameSet(service.groupIds, expectedServiceGroups)) {
    await mutate(invoke, environment, USERMOD, [
      '--gid', selected.readGroup,
      '--groups', `${selected.coordinationGroup},${selected.managementGroup}`,
      '--home', selected.home,
      '--shell', selected.shell,
      '--', selected.serviceAccount,
    ], 'service account reconciliation');
    changed = true;
    current = await observeCurrent();
  }

  const currentOperator = account(current, selected.operatorAccount);
  if (currentOperator.groupIds.includes(management.gid)) throw new Error('Linux local operator has management authority');
  if (!currentOperator.groupIds.includes(read.gid) || !currentOperator.groupIds.includes(coordination.gid)) {
    await mutate(invoke, environment, USERMOD, [
      '--append',
      '--groups', `${selected.readGroup},${selected.coordinationGroup}`,
      '--', selected.operatorAccount,
    ], 'operator capability append');
    changed = true;
    current = await observeCurrent();
  }

  exactBoundIdentity(current, selected, expected);
  return Object.freeze({
    protocol: PROTOCOL,
    platform: 'linux',
    applicable: true,
    changed,
    identity: projectIdentity(current, selected),
  });
}

export { PROTOCOL as LINUX_LOCAL_IDENTITY_RECONCILIATION_PROTOCOL };
