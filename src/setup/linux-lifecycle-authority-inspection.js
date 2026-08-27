import { lstat, readFile, readlink, readdir } from 'node:fs/promises';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import {
  LINUX_LOCAL_IDENTITIES_PROTOCOL,
} from './linux-local-identities.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from './linux-lifecycle-authority.js';
import {
  measureProtectedAuthorityRuntimeCandidate,
  verifyProtectedAuthorityRuntimeAccess,
} from './protected-authority-runtime-candidate.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-inspection-v1';
const OWNERSHIP_PROTOCOL = 'devbridge/linux-lifecycle-authority-ownership-v1';
const GENERATION_PROTOCOL = 'devbridge/linux-lifecycle-authority-generation-v1';
const SYSTEMCTL = '/usr/bin/systemctl';
const GENERATION = /^[0-9a-f]{64}$/u;

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

function exactGeneration(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !GENERATION.test(value)) throw new Error(`${name} is invalid`);
  return value;
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

function normalizeOwnership(raw, plan) {
  exactKeys(raw, new Set([
    'protocol',
    'authorityIdentity',
    'serviceName',
    'operatorName',
    'managementGroup',
    'activeGeneration',
    'stagedGeneration',
    'retainedGenerations',
  ]), 'Linux lifecycle authority ownership record');
  if (raw.protocol !== OWNERSHIP_PROTOCOL
      || raw.authorityIdentity !== plan.authorityIdentity
      || raw.serviceName !== plan.service.name
      || raw.operatorName !== plan.service.operator
      || raw.managementGroup !== plan.service.managementGroup) {
    throw new Error('Linux lifecycle authority ownership record does not match this installation');
  }
  if (!Array.isArray(raw.retainedGenerations) || raw.retainedGenerations.length > 8) {
    throw new Error('Linux lifecycle authority retained generation evidence is invalid');
  }
  const retainedGenerations = raw.retainedGenerations.map((value) => exactGeneration(value, 'Linux lifecycle authority retained generation'));
  if (new Set(retainedGenerations).size !== retainedGenerations.length) throw new Error('Linux lifecycle authority retained generation evidence is ambiguous');
  const activeGeneration = exactGeneration(raw.activeGeneration, 'Linux lifecycle authority active generation', { nullable: true });
  const stagedGeneration = exactGeneration(raw.stagedGeneration, 'Linux lifecycle authority staged generation', { nullable: true });
  if (activeGeneration != null && (activeGeneration === stagedGeneration || retainedGenerations.includes(activeGeneration))) {
    throw new Error('Linux lifecycle authority active generation evidence aliases another state');
  }
  if (stagedGeneration != null && retainedGenerations.includes(stagedGeneration)) {
    throw new Error('Linux lifecycle authority staged generation evidence aliases retained state');
  }
  return Object.freeze({ ...raw, activeGeneration, stagedGeneration, retainedGenerations: Object.freeze(retainedGenerations) });
}

function normalizeGenerationManifest(raw, plan) {
  exactKeys(raw, new Set(['protocol', 'authorityIdentity', 'generation', 'packageDigest', 'nodeDigest']), 'Linux lifecycle authority generation record');
  if (raw.protocol !== GENERATION_PROTOCOL || raw.authorityIdentity !== plan.authorityIdentity) {
    throw new Error('Linux lifecycle authority generation record does not match this installation');
  }
  const generation = exactGeneration(raw.generation, 'Linux lifecycle authority generation record identity');
  const packageDigest = exactGeneration(raw.packageDigest, 'Linux lifecycle authority package digest');
  const nodeDigest = exactGeneration(raw.nodeDigest, 'Linux lifecycle authority Node digest');
  if (generation !== plan.runtime.generation || packageDigest !== plan.runtimeEvidence.packageDigest || nodeDigest !== plan.runtimeEvidence.nodeDigest) {
    throw new Error('Linux lifecycle authority generation record does not match the exact candidate');
  }
  return Object.freeze({ protocol: GENERATION_PROTOCOL, authorityIdentity: raw.authorityIdentity, generation, packageDigest, nodeDigest });
}

async function readBoundedJson(file, expectedInfo, load, name) {
  if (!realKind(expectedInfo, 'file') || expectedInfo.size < 2 || expectedInfo.size > 32 * 1024) throw new Error(`${name} is not a bounded real file`);
  try { return JSON.parse(await load(file, 'utf8')); }
  catch { throw new Error(`${name} is invalid JSON`); }
}

async function readBoundedText(file, expectedInfo, load, maximumBytes) {
  if (!realKind(expectedInfo, 'file') || expectedInfo.size < 1 || expectedInfo.size > maximumBytes) return null;
  return await load(file, 'utf8');
}

function parseSystemdShow(stdout) {
  const allowed = new Set(['LoadState', 'ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'User', 'Group', 'SupplementaryGroups', 'Type']);
  const values = new Map();
  const lines = String(stdout ?? '').trim().split('\n').filter(Boolean);
  if (lines.length !== allowed.size) throw new Error('Linux lifecycle authority service observation is incomplete');
  for (const line of lines) {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('Linux lifecycle authority service observation is invalid');
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (!allowed.has(key) || values.has(key) || /[\0\r]/u.test(value)) throw new Error('Linux lifecycle authority service observation is invalid');
    values.set(key, value);
  }
  return Object.freeze({
    loadState: values.get('LoadState'),
    activeState: values.get('ActiveState'),
    subState: values.get('SubState'),
    mainPid: numeric(values.get('MainPID'), 'Linux lifecycle authority service pid'),
    fragmentPath: values.get('FragmentPath'),
    user: values.get('User'),
    group: values.get('Group'),
    supplementaryGroups: Object.freeze(values.get('SupplementaryGroups').split(/\s+/u).filter(Boolean)),
    type: values.get('Type'),
  });
}

async function inspectSystemdService(plan, invoke, environment) {
  let result;
  try {
    result = await invoke({
      executable: SYSTEMCTL,
      arguments: [
        'show', plan.service.name, '--no-pager',
        '--property=LoadState', '--property=ActiveState', '--property=SubState', '--property=MainPID',
        '--property=FragmentPath', '--property=User', '--property=Group', '--property=SupplementaryGroups', '--property=Type',
      ],
      input: null,
      timeoutMs: 15_000,
      maxOutputBytes: 32 * 1024,
      environment,
    });
  } catch {
    return Object.freeze({ observable: false, exists: false, reason: 'service manager observation unavailable' });
  }
  if (result?.exitCode !== 0 || result?.timedOut === true || result?.aborted === true || result?.outputTruncated === true) {
    return Object.freeze({ observable: false, exists: false, reason: 'service manager observation failed' });
  }
  const observed = parseSystemdShow(result.stdout);
  return Object.freeze({ observable: true, exists: observed.loadState !== 'not-found', ...observed });
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

function runtimeFileEvidenceReady(filesystem) {
  return [
    'generationsDirectory',
    'generationDirectory',
    'binDirectory',
    'packageDirectory',
    'generationManifest',
    'nodeExecutable',
    'packageManifest',
    'serviceEntry',
  ].every((name) => {
    const entry = filesystem[name];
    return entry.exists && entry.kind && entry.owner && entry.group && entry.mode;
  });
}

export async function inspectLinuxLifecycleAuthorityState({
  plan,
  identities,
  platform = process.platform,
  invoke = invokeCommand,
  environment = process.env,
} = {}, {
  stat = lstat,
  load = readFile,
  link = readlink,
  readDirectory = readdir,
  measureRuntime = measureProtectedAuthorityRuntimeCandidate,
  verifyRuntimeAccess = verifyProtectedAuthorityRuntimeAccess,
} = {}) {
  if (platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform, applicable: false });
  if (!plan || plan.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL || plan.runtimeEvidence == null || plan.runtime?.generation == null || typeof plan.service?.unit !== 'string') {
    throw new TypeError('Linux lifecycle authority inspection plan is invalid');
  }
  if (typeof invoke !== 'function' || typeof stat !== 'function' || typeof load !== 'function' || typeof link !== 'function' || typeof readDirectory !== 'function' || typeof measureRuntime !== 'function' || typeof verifyRuntimeAccess !== 'function') {
    throw new TypeError('Linux lifecycle authority inspection ports are invalid');
  }
  const identity = identityEvidence(plan, identities);
  const rootUid = 0;
  const rootGid = 0;
  const serviceUid = identity.service.record?.uid ?? -1;
  const readGid = identity.read.record?.gid ?? -1;
  const paths = {
    unit: plan.service.unitPath,
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
    runRoot: plan.endpoints.runRoot,
    readDirectory: plan.endpoints.read.directory,
    mutationDirectory: plan.endpoints.mutation.directory,
    readEndpoint: plan.endpoints.read.endpoint,
    mutationEndpoint: plan.endpoints.mutation.endpoint,
  };
  const entries = new Map(await Promise.all(Object.entries(paths).map(async ([name, file]) => [name, await optionalLstat(file, stat)])));
  const unitText = entries.get('unit') == null
    ? null
    : await readBoundedText(plan.service.unitPath, entries.get('unit'), load, 64 * 1024);
  const ownership = entries.get('ownershipManifest') == null
    ? null
    : normalizeOwnership(await readBoundedJson(plan.ownershipManifest, entries.get('ownershipManifest'), load, 'Linux lifecycle authority ownership record'), plan);
  const generationRecord = entries.get('generationManifest') == null
    ? null
    : normalizeGenerationManifest(await readBoundedJson(plan.runtime.generationManifest, entries.get('generationManifest'), load, 'Linux lifecycle authority generation record'), plan);
  const service = await inspectSystemdService(plan, invoke, environment);
  const processEvidence = await inspectProcess(plan, service, identity, load, link);
  const expectedSupplements = [plan.service.coordinationGroup, plan.service.managementGroup];
  const serviceEvidence = Object.freeze({
    ...service,
    unitExact: unitText === plan.service.unit,
    identity: service.exists === true && service.user === plan.service.user && service.group === plan.service.readGroup,
    groups: service.exists === true && sameSet(service.supplementaryGroups ?? [], expectedSupplements),
    fragment: service.exists === true && service.fragmentPath === plan.service.unitPath,
    startBoundary: service.type === 'exec',
  });
  const filesystem = Object.freeze({
    unit: filePolicy(entries.get('unit'), { uid: rootUid, gid: rootGid, expectedMode: 0o644, kind: 'file' }),
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
    runRoot: filePolicy(entries.get('runRoot'), { uid: rootUid, gid: rootGid, expectedMode: 0o755, kind: 'directory' }),
    readDirectory: filePolicy(entries.get('readDirectory'), { uid: serviceUid, gid: readGid, expectedMode: plan.endpoints.read.directoryMode, kind: 'directory' }),
    mutationDirectory: filePolicy(entries.get('mutationDirectory'), { uid: serviceUid, gid: rootGid, expectedMode: plan.endpoints.mutation.directoryMode, kind: 'directory' }),
    readEndpoint: filePolicy(entries.get('readEndpoint'), { uid: serviceUid, gid: readGid, expectedMode: plan.endpoints.read.socketMode, kind: 'socket' }),
    mutationEndpoint: filePolicy(entries.get('mutationEndpoint'), { uid: serviceUid, gid: rootGid, expectedMode: plan.endpoints.mutation.socketMode, kind: 'socket' }),
  });

  let runtime = Object.freeze({ ready: false, access: false, exact: false });
  if (generationRecord != null && runtimeFileEvidenceReady(filesystem)) {
    const [measured, access] = await Promise.all([
      measureRuntime({ packageRoot: plan.runtime.packageDirectory, nodeExecutable: plan.runtime.nodeExecutable }),
      verifyRuntimeAccess({
        generationDirectory: plan.runtime.generationDirectory,
        packageDirectory: plan.runtime.packageDirectory,
        nodeExecutable: plan.runtime.nodeExecutable,
        generationManifest: plan.runtime.generationManifest,
      }, { stat, readDirectory }),
    ]);
    const exact = measured.evidence.packageDigest === plan.runtimeEvidence.packageDigest
      && measured.evidence.nodeDigest === plan.runtimeEvidence.nodeDigest;
    runtime = Object.freeze({ ready: access.ready === true && exact, access: access.ready === true, exact, evidence: measured.evidence });
  }

  return Object.freeze({
    protocol: PROTOCOL,
    platform: 'linux',
    applicable: true,
    authorityIdentity: plan.authorityIdentity,
    identities: Object.freeze({ service: identity.serviceReady, operator: identity.operatorReady, serviceUid, readGid, rootGid, serviceGroupIds: identity.service?.groupIds ?? Object.freeze([]) }),
    ownership: Object.freeze({ exists: ownership != null, exact: ownership?.activeGeneration === plan.runtime.generation && ownership?.stagedGeneration == null, record: ownership }),
    generation: Object.freeze({ exists: generationRecord != null, exact: generationRecord != null, record: generationRecord }),
    service: serviceEvidence,
    process: processEvidence,
    filesystem,
    runtime,
  });
}

export {
  GENERATION_PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_GENERATION_PROTOCOL,
  OWNERSHIP_PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
  PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL,
};
