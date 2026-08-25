import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import {
  LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL,
} from './linux-lifecycle-authority-inspection.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from './linux-lifecycle-authority.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-protection-v1';
const DENIED_CODES = new Set(['EACCES', 'EPERM']);
const SHA256 = /^[0-9a-f]{64}$/u;
const FILESYSTEM_EVIDENCE = Object.freeze([
  'protectedRoot',
  'authorityState',
  'binDirectory',
  'runtimeDirectory',
  'packageDirectory',
  'nodeExecutable',
  'packageManifest',
  'serviceEntry',
  'ownershipManifest',
  'runRoot',
  'readDirectory',
  'mutationDirectory',
]);

function allTrue(record, keys) {
  return record != null && keys.every((key) => record[key] === true);
}

function requireStructuralEvidence(plan, inspection) {
  if (!plan || plan.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL) throw new TypeError('Linux lifecycle authority protection plan is invalid');
  if (!inspection || inspection.protocol !== LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL || inspection.applicable !== true || inspection.authorityIdentity !== plan.authorityIdentity) {
    throw new TypeError('Linux lifecycle authority protection inspection is invalid');
  }
  const account = inspection.accounts?.service;
  if (!allTrue(account, ['exists', 'nonRoot', 'home', 'shell', 'primaryReadGroup']) || !Array.isArray(account?.unexpectedGroups) || account.unexpectedGroups.length !== 0) {
    throw new Error('Linux lifecycle authority service identity protection mismatch');
  }
  if (!allTrue(inspection.accounts?.readGroup, ['exists', 'service', 'operator']) || !allTrue(inspection.accounts?.coordinationGroup, ['exists', 'service', 'operator'])) {
    throw new Error('Linux lifecycle authority local capability group protection mismatch');
  }
  if (!allTrue(inspection.accounts?.providerGroup, ['exists', 'service']) || inspection.accounts.providerGroup.operator !== false) {
    throw new Error('Linux lifecycle authority provider capability protection mismatch');
  }
  const service = inspection.service;
  if (!allTrue(service, ['observable', 'exists', 'identity', 'groups', 'fragment']) || service.loadState !== 'loaded' || service.activeState !== 'active' || service.subState !== 'running' || !Number.isSafeInteger(service.mainPid) || service.mainPid < 1) {
    throw new Error('Linux lifecycle authority service protection mismatch');
  }
  if (!allTrue(service.unitFile, ['exists', 'real', 'rootOwned', 'mode', 'exact'])) throw new Error('Linux lifecycle authority unit protection mismatch');
  if (!inspection.filesystem || FILESYSTEM_EVIDENCE.some((key) => !allTrue(inspection.filesystem[key], ['exists', 'kind', 'owner', 'group', 'mode']))) {
    throw new Error('Linux lifecycle authority filesystem protection mismatch');
  }
  const ownership = inspection.ownership;
  const runtime = ownership?.record?.runtime;
  if (ownership?.exists !== true || ownership.valid !== true || ownership.record?.stateMigrationComplete !== true || ownership.record?.serviceConfigured !== true || ownership.record?.serviceReady !== true || !SHA256.test(runtime?.packageDigest ?? '') || !SHA256.test(runtime?.nodeDigest ?? '')) {
    throw new Error('Linux lifecycle authority ownership protection mismatch');
  }
  if (inspection.provider?.group !== plan.service.providerGroup || inspection.provider?.serviceMember !== true || inspection.provider?.operatorMember !== false || typeof inspection.provider?.socket !== 'string' || inspection.provider.socket.length === 0) {
    throw new Error('Linux lifecycle authority provider protection mismatch');
  }
  return inspection;
}

async function proveAccessDenied(target, flags, label, accessFile = access) {
  try {
    await accessFile(target, flags);
  } catch (error) {
    if (DENIED_CODES.has(error?.code)) return;
    throw new Error(`Linux lifecycle authority ${label} denial could not be proved`);
  }
  throw new Error(`Linux lifecycle authority ${label} remains accessible to the ordinary setup identity`);
}

export async function verifyLinuxLifecycleAuthorityProtection({
  plan,
  inspection,
  mode = 'structural',
} = {}, {
  accessFile = access,
} = {}) {
  const selected = requireStructuralEvidence(plan, inspection);
  if (!['structural', 'ordinary-negative'].includes(mode)) throw new TypeError('Linux lifecycle authority protection mode is invalid');
  if (typeof accessFile !== 'function') throw new TypeError('Linux lifecycle authority protection access contract is invalid');

  if (mode === 'ordinary-negative') {
    await proveAccessDenied(plan.ownershipManifest, constants.W_OK, 'protected ownership write', accessFile);
    await proveAccessDenied(plan.runtime.nodeExecutable, constants.W_OK, 'protected runtime write', accessFile);
    await proveAccessDenied(plan.endpoints.mutation.directory, constants.X_OK, 'mutation capability traversal', accessFile);
    await proveAccessDenied(selected.provider.socket, constants.R_OK | constants.W_OK, 'provider management capability', accessFile);
  }

  return Object.freeze({ protocol: PROTOCOL, ready: true, mode });
}

export { PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_PROTECTION_PROTOCOL };
