import { lstat, readFile, readlink, readdir } from 'node:fs/promises';
import process from 'node:process';
import {
  LINUX_LOCAL_IDENTITIES_PROTOCOL,
} from './linux-local-identities.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from './linux-lifecycle-authority.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_GENERATION_MANIFEST_MAX_BYTES,
  LINUX_LIFECYCLE_AUTHORITY_GENERATION_VERIFICATION_PROTOCOL,
  normalizeLinuxLifecycleAuthorityGenerationManifest,
  verifyLinuxLifecycleAuthorityGeneration,
} from './linux-lifecycle-authority-generation.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
  normalizeLinuxLifecycleAuthorityOwnershipRecord,
} from './linux-lifecycle-authority-records.js';
import {
  inspectLinuxProtectedEntry,
  verifyLinuxProtectedFile,
} from './linux-protected-storage.js';
import {
  verifyLinuxProtectedTree,
} from './linux-protected-tree.js';
import {
  LINUX_SERVICE_OBSERVATION_PROTOCOL,
  observeLinuxService,
} from './linux-service-observation.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-inspection-v1';

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name} contains an unknown field`);
  return value;
}

function numeric(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

async function optionalLstat(file, stat) {
  try { return await stat(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function mode(info) {
  return info.mode & 0o7777;
}

function realKind(info, kind) {
  if (info == null || info.isSymbolicLink()) return false;
  if (kind === 'directory') return info.isDirectory();
  if (kind === 'file') return info.isFile();
  if (kind === 'socket') return info.isSocket();
  return false;
}

function filePolicy(info, { uid, gid, expectedMode, kind }) {
  return Object.freeze({
    exists: info != null,
    kind: realKind(info, kind),
    owner: info?.uid === uid,
    group: info?.gid === gid,
    mode: info == null ? false : mode(info) === expectedMode,
    observedMode: info == null ? null : mode(info),
  });
}

function account(identities, name) {
  return identities.accounts.find((entry) => entry.name === name) ?? null;
}

function group(identities, name) {
  return identities.groups.find((entry) => entry.name === name) ?? null;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function identityEvidence(plan, identities) {
  if (!identities || identities.protocol !== LINUX_LOCAL_IDENTITIES_PROTOCOL || identities.applicable !== true) {
    throw new TypeError('Linux lifecycle authority local identity observation is invalid');
  }
  const operator = account(identities, plan.service.operator);
  const service = account(identities, plan.service.user);
  const root = group(identities, 'root');
  const read = group(identities, plan.service.readGroup);
  const coordination = group(identities, plan.service.coordinationGroup);
  const management = group(identities, plan.service.managementGroup);
  const selectedGroups = [root, read, coordination, management];
  if (selectedGroups.some((entry) => entry?.record == null)) throw new Error('Linux lifecycle authority identity observation is incomplete');
  if (root.record.gid !== 0) throw new Error('Linux lifecycle authority root group evidence is invalid');
  const gids = selectedGroups.map((entry) => entry.record.gid);
  if (new Set(gids).size !== gids.length) throw new Error('Linux lifecycle authority identity observation aliases groups');
  const expectedServiceGroups = [read.record?.gid, coordination.record?.gid, management.record?.gid].filter(Number.isSafeInteger).sort((left, right) => left - right);
  return Object.freeze({
    operator,
    service,
    root,
    read,
    coordination,
    management,
    expectedServiceGroups: Object.freeze(expectedServiceGroups),
    serviceReady: service?.record != null
      && service.record.uid !== 0
      && service.record.gid === read.record?.gid
      && service.record.home === plan.service.account.home
      && service.record.shell === plan.service.account.shell
      && sameSet(service.groupIds, expectedServiceGroups),
    operatorReady: operator?.record != null
      && operator.groupIds.includes(read.record?.gid)
      && operator.groupIds.includes(coordination.record?.gid)
      && !operator.groupIds.includes(management.record?.gid),
  });
}

async function readBoundedJson(file, expectedInfo, load, name, maximumBytes = 32 * 1024) {
  if (!realKind(expectedInfo, 'file') || expectedInfo.size < 2 || expectedInfo.size > maximumBytes) throw new Error(`${name} is not a bounded real file`);
  try { return JSON.parse(await load(file, 'utf8')); }
  catch { throw new Error(`${name} is invalid JSON`); }
}

async function readBoundedText(file, expectedInfo, load, maximumBytes) {
  if (!realKind(expectedInfo, 'file') || expectedInfo.size < 1 || expectedInfo.size > maximumBytes) return null;
  return await load(file, 'utf8');
}

function parseProcessStatus(text) {
  const selected = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^(Uid|Gid|Groups):\s*(.*?)\s*$/u.exec(line);
    if (!match) continue;
    if (selected.has(match[1])) throw new Error('Linux lifecycle authority process identity is ambiguous');
    const values = match[2].split(/\s+/u).filter(Boolean).map((value) => numeric(value, 'Linux lifecycle authority process identity'));
    selected.set(match[1], values);
  }
  if (!selected.has('Uid') || selected.get('Uid').length !== 4 || !selected.has('Gid') || selected.get('Gid').length !== 4 || !selected.has('Groups')) {
    throw new Error('Linux lifecycle authority process identity is incomplete');
  }
  return Object.freeze({ uids: Object.freeze(selected.get('Uid')), gids: Object.freeze(selected.get('Gid')), groups: Object.freeze(selected.get('Groups').sort((left, right) => left - right)) });
}

async function inspectProcess(plan, service, identity, load, link) {
  if (!service.observable || service.mainPid < 1) return Object.freeze({ observable: false, identity: false, groups: false, executable: false });
  try {
    const status = parseProcessStatus(await load(`/proc/${service.mainPid}/status`, 'utf8'));
    const executable = await link(`/proc/${service.mainPid}/exe`);
    const expectedUid = identity.service.record.uid;
    const expectedGid = identity.read.record.gid;
    return Object.freeze({
      observable: true,
      identity: status.uids.every((value) => value === expectedUid) && status.gids.every((value) => value === expectedGid),
      groups: sameSet(status.groups, identity.expectedServiceGroups),
      executable: executable === plan.runtime.nodeExecutable,
      uids: status.uids,
      gids: status.gids,
      groupIds: status.groups,
    });
  } catch {
    return Object.freeze({ observable: false, identity: false, groups: false, executable: false });
  }
}

async function verifyGenerationOnFilesystem(value, { stat, readDirectory }) {
  return await verifyLinuxLifecycleAuthorityGeneration(value, {
    verify: async (request) => {
      const observed = await verifyLinuxProtectedTree(request, {
        observeEntry: async (entry) => {
          const entryEvidence = await inspectLinuxProtectedEntry(entry, { stat });
          return Object.freeze({
            exists: entryEvidence.exists,
            kind: entryEvidence.kind,
            owner: entryEvidence.owner,
            group: entryEvidence.group,
            mode: entryEvidence.mode,
          });
        },
        verifyFile: async (entry) => {
          const fileEvidence = await verifyLinuxProtectedFile(entry, { stat });
          return Object.freeze({ ready: fileEvidence.ready, size: fileEvidence.size, digest: fileEvidence.digest });
        },
        listDirectory: readDirectory,
      });
      return Object.freeze({ path: observed.path, entries: observed.entries, ready: observed.ready });
    },
  });
}

export async function inspectLinuxLifecycleAuthorityState({
  plan,
  identities,
  platform = process.platform,
} = {}, {
  stat = lstat,
  load = readFile,
  link = readlink,
  readDirectory = readdir,
  verifyGeneration = verifyGenerationOnFilesystem,
  observeService = observeLinuxService,
} = {}) {
  if (platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform, applicable: false });
  if (!plan || plan.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL || plan.runtimeEvidence == null || plan.runtime?.generation == null || typeof plan.service?.unit !== 'string') {
    throw new TypeError('Linux lifecycle authority inspection plan is invalid');
  }
  if (typeof stat !== 'function' || typeof load !== 'function' || typeof link !== 'function' || typeof readDirectory !== 'function' || typeof verifyGeneration !== 'function' || typeof observeService !== 'function') {
    throw new TypeError('Linux lifecycle authority inspection ports are invalid');
  }
  const identity = identityEvidence(plan, identities);
  const rootUid = 0;
  const rootGid = 0;
  const serviceUid = identity.service.record?.uid ?? -1;
  const operatorUid = identity.operator.record?.uid ?? -1;
  const readGid = identity.read.record?.gid ?? -1;
  const coordinationGid = identity.coordination.record?.gid ?? -1;
  const managementGid = identity.management.record?.gid ?? -1;
  const paths = {
    unit: plan.service.unitPath,
    endpointDefinition: plan.endpoints.definition.path,
    protectedRoot: plan.protectedRoot,
    authorityState: plan.authorityDirectory,
    ownershipManifest: plan.ownershipManifest,
    generationsDirectory: plan.runtime.generationsDirectory,
    generationDirectory: plan.runtime.generationDirectory,
    binDirectory: plan.runtime.binDirectory,
    packageDirectory: plan.runtime.packageDirectory,
    generationManifest: plan.runtime.generationManifest,
    nodeExecutable: plan.runtime.nodeExecutable,
    packageManifest: plan.runtime.packageManifest,
    serviceEntry: plan.runtime.serviceEntry,
    endpointsParent: plan.endpoints.parentDirectory,
    runRoot: plan.endpoints.runRoot,
    governanceDirectory: plan.coordination.directory,
    governanceLock: plan.coordination.lock.path,
    readDirectory: plan.endpoints.read.directory,
    mutationDirectory: plan.endpoints.mutation.directory,
    readEndpoint: plan.endpoints.read.endpoint,
    mutationEndpoint: plan.endpoints.mutation.endpoint,
    configurationRoot: plan.configuration.root,
    configurationEndpointDirectory: plan.configuration.endpoint.directory,
    configurationHandoffDirectory: plan.configuration.handoff.directory,
    configurationEndpoint: plan.configuration.endpoint.endpoint,
    activityRoot: plan.activity.root,
    activityEndpointDirectory: plan.activity.endpoint.directory,
    activityHandoffDirectory: plan.activity.handoff.directory,
    activityEndpoint: plan.activity.endpoint.endpoint,
  };
  const entries = new Map(await Promise.all(Object.entries(paths).map(async ([name, file]) => [name, await optionalLstat(file, stat)])));
  const unitText = entries.get('unit') == null
    ? null
    : await readBoundedText(plan.service.unitPath, entries.get('unit'), load, 64 * 1024);
  const endpointDefinitionText = entries.get('endpointDefinition') == null
    ? null
    : await readBoundedText(plan.endpoints.definition.path, entries.get('endpointDefinition'), load, 64 * 1024);
  const ownership = entries.get('ownershipManifest') == null
    ? null
    : normalizeLinuxLifecycleAuthorityOwnershipRecord(await readBoundedJson(plan.ownershipManifest, entries.get('ownershipManifest'), load, 'Linux lifecycle authority ownership record'), plan);
  const generationRecord = entries.get('generationManifest') == null
    ? null
    : normalizeLinuxLifecycleAuthorityGenerationManifest(
      await readBoundedJson(
        plan.runtime.generationManifest,
        entries.get('generationManifest'),
        load,
        'Linux lifecycle authority generation record',
        LINUX_LIFECYCLE_AUTHORITY_GENERATION_MANIFEST_MAX_BYTES,
      ),
      plan,
    );
  const service = await observeService({ unit: plan.service.name, platform: 'linux' });
  if (!service || service.protocol !== LINUX_SERVICE_OBSERVATION_PROTOCOL || service.applicable !== true) {
    throw new Error('Linux lifecycle authority service observation is invalid');
  }
  const processEvidence = await inspectProcess(plan, service, identity, load, link);
  const expectedSupplements = [plan.service.coordinationGroup, plan.service.managementGroup];
  const serviceEvidence = Object.freeze({
    ...service,
    unitExact: unitText === plan.service.unit,
    identity: service.exists === true && service.user === plan.service.user && service.group === plan.service.readGroup,
    groups: service.exists === true && sameSet(service.supplementaryGroups ?? [], expectedSupplements),
    fragment: service.exists === true && service.fragmentPath === plan.service.unitPath,
    startBoundary: service.type === 'exec',
    enabled: service.exists === true && service.unitFileState === 'enabled',
    definitionCurrent: service.exists === true && service.definitionCurrent === true,
  });
  const filesystem = Object.freeze({
    unit: filePolicy(entries.get('unit'), { uid: rootUid, gid: rootGid, expectedMode: 0o644, kind: 'file' }),
    endpointDefinition: filePolicy(entries.get('endpointDefinition'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.volatileDefinition.mode, kind: 'file' }),
    protectedRoot: filePolicy(entries.get('protectedRoot'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.protectedRoot.mode, kind: 'directory' }),
    authorityState: filePolicy(entries.get('authorityState'), { uid: serviceUid, gid: rootGid, expectedMode: plan.access.authorityState.mode, kind: 'directory' }),
    ownershipManifest: filePolicy(entries.get('ownershipManifest'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.ownershipManifest.mode, kind: 'file' }),
    generationsDirectory: filePolicy(entries.get('generationsDirectory'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.protectedRuntime.directoryMode, kind: 'directory' }),
    generationDirectory: filePolicy(entries.get('generationDirectory'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.protectedRuntime.directoryMode, kind: 'directory' }),
    binDirectory: filePolicy(entries.get('binDirectory'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.protectedRuntime.directoryMode, kind: 'directory' }),
    packageDirectory: filePolicy(entries.get('packageDirectory'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.protectedRuntime.directoryMode, kind: 'directory' }),
    generationManifest: filePolicy(entries.get('generationManifest'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.protectedRuntime.fileMode, kind: 'file' }),
    nodeExecutable: filePolicy(entries.get('nodeExecutable'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.protectedRuntime.executableMode, kind: 'file' }),
    packageManifest: filePolicy(entries.get('packageManifest'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.protectedRuntime.fileMode, kind: 'file' }),
    serviceEntry: filePolicy(entries.get('serviceEntry'), { uid: rootUid, gid: rootGid, expectedMode: plan.access.protectedRuntime.fileMode, kind: 'file' }),
    endpointsParent: filePolicy(entries.get('endpointsParent'), { uid: rootUid, gid: rootGid, expectedMode: 0o755, kind: 'directory' }),
    runRoot: filePolicy(entries.get('runRoot'), { uid: rootUid, gid: rootGid, expectedMode: 0o755, kind: 'directory' }),
    governanceDirectory: filePolicy(entries.get('governanceDirectory'), { uid: rootUid, gid: coordinationGid, expectedMode: plan.coordination.directoryMode, kind: 'directory' }),
    governanceLock: filePolicy(entries.get('governanceLock'), { uid: rootUid, gid: coordinationGid, expectedMode: plan.coordination.lock.mode, kind: 'file' }),
    readDirectory: filePolicy(entries.get('readDirectory'), { uid: serviceUid, gid: readGid, expectedMode: plan.endpoints.read.directoryMode, kind: 'directory' }),
    mutationDirectory: filePolicy(entries.get('mutationDirectory'), { uid: serviceUid, gid: rootGid, expectedMode: plan.endpoints.mutation.directoryMode, kind: 'directory' }),
    readEndpoint: filePolicy(entries.get('readEndpoint'), { uid: serviceUid, gid: readGid, expectedMode: plan.endpoints.read.socketMode, kind: 'socket' }),
    mutationEndpoint: filePolicy(entries.get('mutationEndpoint'), { uid: serviceUid, gid: readGid, expectedMode: plan.endpoints.mutation.socketMode, kind: 'socket' }),
    configurationRoot: filePolicy(entries.get('configurationRoot'), { uid: rootUid, gid: rootGid, expectedMode: 0o755, kind: 'directory' }),
    configurationEndpointDirectory: filePolicy(entries.get('configurationEndpointDirectory'), { uid: serviceUid, gid: coordinationGid, expectedMode: plan.configuration.endpoint.directoryMode, kind: 'directory' }),
    configurationHandoffDirectory: filePolicy(entries.get('configurationHandoffDirectory'), { uid: rootUid, gid: coordinationGid, expectedMode: plan.configuration.handoff.directoryMode, kind: 'directory' }),
    configurationEndpoint: filePolicy(entries.get('configurationEndpoint'), { uid: serviceUid, gid: coordinationGid, expectedMode: plan.configuration.endpoint.socketMode, kind: 'socket' }),
    activityRoot: filePolicy(entries.get('activityRoot'), { uid: rootUid, gid: rootGid, expectedMode: 0o755, kind: 'directory' }),
    activityEndpointDirectory: filePolicy(entries.get('activityEndpointDirectory'), { uid: serviceUid, gid: readGid, expectedMode: plan.activity.endpoint.directoryMode, kind: 'directory' }),
    activityHandoffDirectory: filePolicy(entries.get('activityHandoffDirectory'), { uid: rootUid, gid: readGid, expectedMode: plan.activity.handoff.directoryMode, kind: 'directory' }),
    activityEndpoint: filePolicy(entries.get('activityEndpoint'), { uid: serviceUid, gid: readGid, expectedMode: plan.activity.endpoint.socketMode, kind: 'socket' }),
  });

  let runtime = Object.freeze({ ready: false, exact: false, generation: null });
  if (generationRecord != null) {
    try {
      const verified = await verifyGeneration({ plan, manifest: generationRecord }, { stat, readDirectory });
      exactKeys(verified, new Set(['protocol', 'generation', 'verified']), 'Linux lifecycle authority generation verification');
      const exact = verified.protocol === LINUX_LIFECYCLE_AUTHORITY_GENERATION_VERIFICATION_PROTOCOL
        && verified.generation === plan.runtime.generation
        && verified.verified === true;
      runtime = Object.freeze({ ready: exact, exact, generation: verified.generation });
    } catch {
      runtime = Object.freeze({ ready: false, exact: false, generation: plan.runtime.generation });
    }
  }

  return Object.freeze({
    protocol: PROTOCOL,
    platform: 'linux',
    applicable: true,
    authorityIdentity: plan.authorityIdentity,
    identities: Object.freeze({ service: identity.serviceReady, operator: identity.operatorReady, serviceUid, operatorUid, readGid, coordinationGid, managementGid, rootGid, serviceGroupIds: identity.service?.groupIds ?? Object.freeze([]) }),
    ownership: Object.freeze({
      exists: ownership != null,
      exact: ownership?.activeGeneration === plan.runtime.generation
        && ownership?.stagedGeneration == null
        && ownership?.localIdentity?.serviceUid === serviceUid
        && ownership?.localIdentity?.operatorUid === operatorUid
        && ownership?.localIdentity?.readGid === readGid
        && ownership?.localIdentity?.coordinationGid === coordinationGid
        && ownership?.localIdentity?.managementGid === managementGid,
      record: ownership,
    }),
    generation: Object.freeze({ exists: generationRecord != null, exact: generationRecord != null, record: generationRecord }),
    topology: Object.freeze({ definitionExact: endpointDefinitionText === plan.endpoints.definition.content }),
    service: serviceEvidence,
    process: processEvidence,
    filesystem,
    runtime,
  });
}

export {
  LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
  PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL,
};
