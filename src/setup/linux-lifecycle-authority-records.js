import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from './linux-lifecycle-authority.js';
import {
  ensureLinuxProtectedDirectory,
  inspectLinuxProtectedEntry,
  readLinuxProtectedFile,
  writeLinuxProtectedFile,
} from './linux-protected-storage.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-records-v1';
const OWNERSHIP_PROTOCOL = 'devbridge/linux-lifecycle-authority-ownership-v1';
const GENERATION = /^[0-9a-f]{64}$/u;
const MAX_RECORD_BYTES = 32 * 1024;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function numeric(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`);
  return value;
}

function generation(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !GENERATION.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function exactPlan(plan) {
  if (!plan || plan.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL) throw new TypeError('Linux lifecycle authority record plan is invalid');
  if (path.posix.dirname(plan.storage?.rootDirectory ?? '') !== plan.storage?.parentDirectory
      || path.posix.dirname(plan.protectedRoot ?? '') !== plan.storage.rootDirectory
      || path.posix.dirname(plan.ownershipManifest ?? '') !== plan.protectedRoot
      || path.posix.dirname(plan.refreshJournal ?? '') !== plan.protectedRoot) {
    throw new TypeError('Linux lifecycle authority record topology is invalid');
  }
  return plan;
}

function localIdentity(value) {
  if (value == null) return null;
  exactKeys(value, new Set(['serviceUid', 'readGid', 'coordinationGid', 'managementGid']), 'Linux lifecycle authority local identity record');
  const normalized = Object.freeze({
    serviceUid: numeric(value.serviceUid, 'Linux lifecycle authority service uid'),
    readGid: numeric(value.readGid, 'Linux lifecycle authority read gid'),
    coordinationGid: numeric(value.coordinationGid, 'Linux lifecycle authority coordination gid'),
    managementGid: numeric(value.managementGid, 'Linux lifecycle authority management gid'),
  });
  if (new Set([normalized.readGid, normalized.coordinationGid, normalized.managementGid]).size !== 3) {
    throw new TypeError('Linux lifecycle authority local identity record aliases groups');
  }
  return normalized;
}

export function normalizeLinuxLifecycleAuthorityOwnershipRecord(value, plan) {
  const selected = exactPlan(plan);
  exactKeys(value, new Set([
    'protocol',
    'authorityIdentity',
    'serviceName',
    'operatorName',
    'managementGroup',
    'localIdentity',
    'activeGeneration',
    'stagedGeneration',
    'retainedGenerations',
  ]), 'Linux lifecycle authority ownership record');
  if (value.protocol !== OWNERSHIP_PROTOCOL
      || value.authorityIdentity !== selected.authorityIdentity
      || value.serviceName !== selected.service.name
      || value.operatorName !== selected.service.operator
      || value.managementGroup !== selected.service.managementGroup) {
    throw new Error('Linux lifecycle authority ownership record does not match this installation');
  }
  if (!Array.isArray(value.retainedGenerations) || value.retainedGenerations.length > 8) {
    throw new TypeError('Linux lifecycle authority retained generation evidence is invalid');
  }
  const retainedGenerations = value.retainedGenerations.map((entry) => generation(entry, 'Linux lifecycle authority retained generation'));
  if (new Set(retainedGenerations).size !== retainedGenerations.length) throw new TypeError('Linux lifecycle authority retained generation evidence is ambiguous');
  const activeGeneration = generation(value.activeGeneration, 'Linux lifecycle authority active generation', { nullable: true });
  const stagedGeneration = generation(value.stagedGeneration, 'Linux lifecycle authority staged generation', { nullable: true });
  if (activeGeneration != null && (activeGeneration === stagedGeneration || retainedGenerations.includes(activeGeneration))) {
    throw new TypeError('Linux lifecycle authority active generation evidence aliases another state');
  }
  if (stagedGeneration != null && retainedGenerations.includes(stagedGeneration)) {
    throw new TypeError('Linux lifecycle authority staged generation evidence aliases retained state');
  }
  return Object.freeze({
    protocol: OWNERSHIP_PROTOCOL,
    authorityIdentity: selected.authorityIdentity,
    serviceName: selected.service.name,
    operatorName: selected.service.operator,
    managementGroup: selected.service.managementGroup,
    localIdentity: localIdentity(value.localIdentity),
    activeGeneration,
    stagedGeneration,
    retainedGenerations: Object.freeze(retainedGenerations),
  });
}

export function initialLinuxLifecycleAuthorityOwnershipRecord(plan) {
  const selected = exactPlan(plan);
  return normalizeLinuxLifecycleAuthorityOwnershipRecord({
    protocol: OWNERSHIP_PROTOCOL,
    authorityIdentity: selected.authorityIdentity,
    serviceName: selected.service.name,
    operatorName: selected.service.operator,
    managementGroup: selected.service.managementGroup,
    localIdentity: null,
    activeGeneration: null,
    stagedGeneration: null,
    retainedGenerations: [],
  }, selected);
}

function ready(evidence) {
  return evidence.exists && evidence.kind && evidence.owner && evidence.group && evidence.mode;
}

function directoryContract(target, mode) {
  return Object.freeze({ path: target, ownerId: 0, groupId: 0, mode });
}

function fileContract(target, mode) {
  return Object.freeze({ path: target, ownerId: 0, groupId: 0, mode });
}

function parentContract(target, mode = null) {
  return Object.freeze({ path: target, ownerId: 0, groupId: 0, mode });
}

function sameIdentity(left, right) {
  return left?.serviceUid === right?.serviceUid
    && left?.readGid === right?.readGid
    && left?.coordinationGid === right?.coordinationGid
    && left?.managementGid === right?.managementGid;
}

function recordBytes(value, normalize, name) {
  const normalized = normalize(value);
  let encoded;
  try { encoded = JSON.stringify(normalized); }
  catch { throw new TypeError(`${name} is not serializable`); }
  if (typeof encoded !== 'string') throw new TypeError(`${name} is not serializable`);
  const content = Buffer.from(`${encoded}\n`, 'utf8');
  if (content.length < 2 || content.length > MAX_RECORD_BYTES) throw new TypeError(`${name} is outside its bound`);
  let roundTrip;
  try { roundTrip = normalize(JSON.parse(encoded)); }
  catch { throw new TypeError(`${name} does not round-trip exactly`); }
  return Object.freeze({ normalized: roundTrip, content });
}

async function parsedRecord({ contract, normalize, name }, ports) {
  const observed = await ports.inspect({ contract, kind: 'file' });
  if (!observed.exists) return null;
  if (!ready(observed)) throw new Error(`${name} file policy is invalid`);
  const loaded = await ports.load({ contract, maximumBytes: MAX_RECORD_BYTES });
  let value;
  try { value = JSON.parse(loaded.content.toString('utf8')); }
  catch { throw new Error(`${name} is invalid JSON`); }
  try { return normalize(value); }
  catch (error) { throw new Error(`${name} is invalid`, { cause: error }); }
}

function exactNames(value) {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Linux lifecycle authority unclaimed directory is not bounded');
  const names = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > 255 || /[\/\0\r\n]/u.test(entry)) {
      throw new Error('Linux lifecycle authority unclaimed directory entry is invalid');
    }
    return entry;
  });
  if (new Set(names).size !== names.length) throw new Error('Linux lifecycle authority unclaimed directory is ambiguous');
  return names.sort();
}

export function createLinuxLifecycleAuthorityRecordStore({
  plan,
  admitClaim,
  normalizeTransaction,
} = {}, {
  inspect = inspectLinuxProtectedEntry,
  ensureDirectory = ensureLinuxProtectedDirectory,
  load = readLinuxProtectedFile,
  save = writeLinuxProtectedFile,
  listDirectory = readdir,
} = {}) {
  const selected = exactPlan(plan);
  if (typeof admitClaim !== 'function' || typeof normalizeTransaction !== 'function') {
    throw new TypeError('Linux lifecycle authority record ports are invalid');
  }
  for (const [name, port] of Object.entries({ inspect, ensureDirectory, load, save, listDirectory })) {
    if (typeof port !== 'function') throw new TypeError(`Linux lifecycle authority record ${name} port is invalid`);
  }

  const contracts = Object.freeze({
    parent: parentContract(selected.storage.parentDirectory),
    storageRoot: directoryContract(selected.storage.rootDirectory, selected.access.storageRoot.mode),
    protectedRoot: directoryContract(selected.protectedRoot, selected.access.protectedRoot.mode),
    ownership: fileContract(selected.ownershipManifest, selected.access.ownershipManifest.mode),
    transaction: fileContract(selected.refreshJournal, selected.access.refreshJournal.mode),
  });
  const storageParent = parentContract(contracts.storageRoot.path, contracts.storageRoot.mode);
  const recordParent = parentContract(contracts.protectedRoot.path, contracts.protectedRoot.mode);
  const normalizeOwnership = (value) => normalizeLinuxLifecycleAuthorityOwnershipRecord(value, selected);
  const ownershipSpec = Object.freeze({ contract: contracts.ownership, normalize: normalizeOwnership, name: 'Linux lifecycle authority ownership record' });
  const transactionSpec = Object.freeze({ contract: contracts.transaction, normalize: normalizeTransaction, name: 'Linux lifecycle authority transaction record' });

  async function inspectDirectory(contract, name) {
    const observed = await inspect({ contract, kind: 'directory' });
    if (observed.exists && !ready(observed)) throw new Error(`${name} policy is invalid`);
    return observed;
  }

  async function loadOwnership() {
    const parent = await inspectDirectory(contracts.parent, 'Linux lifecycle authority storage parent');
    if (!parent.exists) return null;
    const storageRoot = await inspectDirectory(contracts.storageRoot, 'Linux lifecycle authority storage root');
    if (!storageRoot.exists) return null;
    const protectedRoot = await inspectDirectory(contracts.protectedRoot, 'Linux lifecycle authority protected root');
    if (!protectedRoot.exists) return null;
    return await parsedRecord(ownershipSpec, { inspect, load });
  }

  async function requireUnclaimedDirectory() {
    const names = exactNames(await listDirectory(contracts.protectedRoot.path));
    const recoverable = `${path.posix.basename(contracts.ownership.path)}.devbridge-pending`;
    if (names.some((name) => name !== recoverable)) {
      throw new Error('Linux lifecycle authority unclaimed directory contains foreign state');
    }
  }

  async function ensureClaim() {
    const existing = await loadOwnership();
    if (existing != null) return existing;

    const protectedRoot = await inspectDirectory(contracts.protectedRoot, 'Linux lifecycle authority protected root');
    if (protectedRoot.exists) await requireUnclaimedDirectory();
    if (await admitClaim() !== true) throw new Error('Linux lifecycle authority claim was not admitted');

    await ensureDirectory({ contract: contracts.storageRoot, parent: contracts.parent });
    await ensureDirectory({ contract: contracts.protectedRoot, parent: storageParent });
    await requireUnclaimedDirectory();
    const initial = initialLinuxLifecycleAuthorityOwnershipRecord(selected);
    const encoded = recordBytes(initial, normalizeOwnership, 'Linux lifecycle authority ownership record');
    await save({ contract: contracts.ownership, parent: recordParent, content: encoded.content, maximumBytes: MAX_RECORD_BYTES });
    const installed = await parsedRecord(ownershipSpec, { inspect, load });
    if (installed == null) throw new Error('Linux lifecycle authority claim is not observable');
    return installed;
  }

  async function saveOwnership(value) {
    const encoded = recordBytes(value, normalizeOwnership, 'Linux lifecycle authority ownership record');
    const current = await ensureClaim();
    if (current.localIdentity != null && !sameIdentity(current.localIdentity, encoded.normalized.localIdentity)) {
      throw new Error('Linux lifecycle authority numeric identity binding is immutable');
    }
    await save({ contract: contracts.ownership, parent: recordParent, content: encoded.content, maximumBytes: MAX_RECORD_BYTES });
    const installed = await parsedRecord(ownershipSpec, { inspect, load });
    if (installed == null) throw new Error('Linux lifecycle authority ownership update is not observable');
    return installed;
  }

  async function loadTransaction() {
    const ownership = await loadOwnership();
    const observed = await inspect({ contract: contracts.transaction, kind: 'file' });
    if (ownership == null) {
      if (observed.exists) throw new Error('Linux lifecycle authority transaction exists without an ownership claim');
      return null;
    }
    return await parsedRecord(transactionSpec, { inspect, load });
  }

  async function saveTransaction(value) {
    const encoded = recordBytes(value, normalizeTransaction, 'Linux lifecycle authority transaction record');
    await ensureClaim();
    await save({ contract: contracts.transaction, parent: recordParent, content: encoded.content, maximumBytes: MAX_RECORD_BYTES });
    const installed = await parsedRecord(transactionSpec, { inspect, load });
    if (installed == null) throw new Error('Linux lifecycle authority transaction update is not observable');
    return installed;
  }

  return Object.freeze({
    protocol: PROTOCOL,
    ownership: Object.freeze({ load: loadOwnership, save: saveOwnership }),
    journal: Object.freeze({ load: loadTransaction, save: saveTransaction }),
  });
}

export {
  OWNERSHIP_PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
  PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_RECORDS_PROTOCOL,
};
