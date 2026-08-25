import os from 'node:os';
import { lstat, readFile } from 'node:fs/promises';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-inspection-v1';
const OWNERSHIP_PROTOCOL = 'devbridge/linux-lifecycle-authority-ownership-v1';
const SYSTEMCTL = '/usr/bin/systemctl';
const PASSWD = '/etc/passwd';
const GROUP = '/etc/group';
const PROVIDER_SOCKETS = Object.freeze([
  '/run/libvirt/virtqemud-sock',
  '/run/libvirt/libvirt-sock',
]);
const SHA256 = /^[0-9a-f]{64}$/u;

function numeric(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

function parsePasswd(text) {
  const records = new Map();
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length !== 7) throw new Error('Linux account database is malformed');
    const [name, , uidRaw, gidRaw, , home, shell] = fields;
    if (!name || records.has(name)) throw new Error('Linux account database is ambiguous');
    records.set(name, Object.freeze({ name, uid: numeric(uidRaw, 'Linux account uid'), gid: numeric(gidRaw, 'Linux account gid'), home, shell }));
  }
  return records;
}

function parseGroup(text) {
  const byName = new Map();
  const byGid = new Map();
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length !== 4) throw new Error('Linux group database is malformed');
    const [name, , gidRaw, membersRaw] = fields;
    const gid = numeric(gidRaw, 'Linux group gid');
    if (!name || byName.has(name) || byGid.has(gid)) throw new Error('Linux group database is ambiguous');
    const members = membersRaw.length === 0 ? [] : membersRaw.split(',');
    if (new Set(members).size !== members.length || members.some((member) => member.length === 0)) throw new Error('Linux group database membership is malformed');
    const record = Object.freeze({ name, gid, members: Object.freeze([...members]) });
    byName.set(name, record);
    byGid.set(gid, record);
  }
  return Object.freeze({ byName, byGid });
}

function memberOf(account, group) {
  return account != null && group != null && (account.gid === group.gid || group.members.includes(account.name));
}

function groupsFor(account, groups) {
  if (!account) return Object.freeze([]);
  return Object.freeze([...groups.byName.values()].filter((group) => memberOf(account, group)).map((group) => group.name).sort());
}

async function optionalLstat(file, stat = lstat) {
  try { return await stat(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function mode(info) {
  return info.mode & 0o7777;
}

function realDirectory(info) {
  return info != null && info.isDirectory() && !info.isSymbolicLink();
}

function realFile(info) {
  return info != null && info.isFile() && !info.isSymbolicLink();
}

function realSocket(info) {
  return info != null && info.isSocket() && !info.isSymbolicLink();
}

function filePolicy(info, { uid, gid, mode: expectedMode, kind }) {
  const kindOkay = kind === 'directory' ? realDirectory(info) : kind === 'file' ? realFile(info) : realSocket(info);
  return Object.freeze({
    exists: info != null,
    kind: kindOkay,
    owner: info?.uid === uid,
    group: info?.gid === gid,
    mode: info == null ? false : mode(info) === expectedMode,
    observedMode: info == null ? null : mode(info),
  });
}

function parseSystemdShow(stdout) {
  const allowed = new Set(['LoadState', 'ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'User', 'Group', 'SupplementaryGroups']);
  const values = new Map();
  const lines = String(stdout ?? '').trim().split('\n').filter(Boolean);
  if (lines.length > allowed.size) throw new Error('Linux lifecycle authority service observation is invalid');
  for (const line of lines) {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('Linux lifecycle authority service observation is invalid');
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (!allowed.has(key) || values.has(key) || /[\0\r]/u.test(value)) throw new Error('Linux lifecycle authority service observation is invalid');
    values.set(key, value);
  }
  for (const key of allowed) if (!values.has(key)) throw new Error('Linux lifecycle authority service observation is incomplete');
  return Object.freeze({
    loadState: values.get('LoadState'),
    activeState: values.get('ActiveState'),
    subState: values.get('SubState'),
    mainPid: numeric(values.get('MainPID'), 'Linux lifecycle authority service pid'),
    fragmentPath: values.get('FragmentPath'),
    user: values.get('User'),
    group: values.get('Group'),
    supplementaryGroups: Object.freeze(values.get('SupplementaryGroups').split(/\s+/u).filter(Boolean)),
  });
}

async function inspectSystemdService(plan, { invoke, environment }) {
  let result;
  try {
    result = await invoke({
      executable: SYSTEMCTL,
      arguments: [
        'show', plan.service.name, '--no-pager',
        '--property=LoadState', '--property=ActiveState', '--property=SubState', '--property=MainPID',
        '--property=FragmentPath', '--property=User', '--property=Group', '--property=SupplementaryGroups',
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

function normalizeOwnership(raw, plan) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Linux lifecycle authority ownership record is invalid');
  const allowed = new Set(['protocol', 'authorityIdentity', 'serviceName', 'operatorName', 'providerGroup', 'stateMigrationComplete', 'runtime', 'serviceConfigured', 'serviceReady']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error('Linux lifecycle authority ownership record is invalid');
  if (raw.protocol !== OWNERSHIP_PROTOCOL || raw.authorityIdentity !== plan.authorityIdentity || raw.serviceName !== plan.service.name || raw.operatorName !== plan.service.operator || raw.providerGroup !== plan.service.providerGroup) {
    throw new Error('Linux lifecycle authority ownership record does not match this installation');
  }
  if (typeof raw.stateMigrationComplete !== 'boolean' || typeof raw.serviceConfigured !== 'boolean' || typeof raw.serviceReady !== 'boolean') throw new Error('Linux lifecycle authority ownership state is invalid');
  if (raw.runtime != null) {
    const runtimeAllowed = new Set(['packageDigest', 'nodeDigest']);
    if (!raw.runtime || typeof raw.runtime !== 'object' || Array.isArray(raw.runtime)) throw new Error('Linux lifecycle authority runtime record is invalid');
    for (const key of Object.keys(raw.runtime)) if (!runtimeAllowed.has(key)) throw new Error('Linux lifecycle authority runtime record is invalid');
    for (const key of runtimeAllowed) if (!SHA256.test(raw.runtime[key])) throw new Error('Linux lifecycle authority runtime digest is invalid');
  }
  return Object.freeze({
    protocol: OWNERSHIP_PROTOCOL,
    authorityIdentity: raw.authorityIdentity,
    serviceName: raw.serviceName,
    operatorName: raw.operatorName,
    providerGroup: raw.providerGroup,
    stateMigrationComplete: raw.stateMigrationComplete,
    runtime: raw.runtime == null ? null : Object.freeze({ ...raw.runtime }),
    serviceConfigured: raw.serviceConfigured,
    serviceReady: raw.serviceReady,
  });
}

async function inspectOwnership(plan, stat = lstat, load = readFile) {
  const info = await optionalLstat(plan.ownershipManifest, stat);
  if (info == null) return Object.freeze({ exists: false, valid: false, record: null, info: null });
  if (!realFile(info) || info.size < 2 || info.size > 32 * 1024) throw new Error('Linux lifecycle authority ownership record is not a bounded real file');
  let raw;
  try { raw = JSON.parse(await load(plan.ownershipManifest, 'utf8')); }
  catch { throw new Error('Linux lifecycle authority ownership record is invalid JSON'); }
  return Object.freeze({ exists: true, valid: true, record: normalizeOwnership(raw, plan), info });
}

async function inspectProviderSocket(groups, stat = lstat) {
  for (const candidate of PROVIDER_SOCKETS) {
    const info = await optionalLstat(candidate, stat);
    if (info == null) continue;
    if (!realSocket(info)) throw new Error('Linux provider management endpoint is not a real local socket');
    const group = groups.byGid.get(info.gid);
    if (!group) throw new Error('Linux provider management endpoint group is unknown');
    const permissions = mode(info);
    if (info.gid === 0 || group.name === 'root' || (permissions & 0o060) !== 0o060 || (permissions & 0o006) !== 0) {
      throw new Error('Linux provider management endpoint does not expose a bounded group-only capability');
    }
    return Object.freeze({ available: true, socket: candidate, group: group.name, mode: permissions });
  }
  return Object.freeze({ available: false, socket: null, group: null, mode: null });
}

export async function inspectLinuxLifecycleAuthorityHost({ platform = process.platform } = {}, {
  stat = lstat,
  load = readFile,
  userInfo = os.userInfo,
} = {}) {
  if (platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform, applicable: false });
  const [passwdText, groupText] = await Promise.all([load(PASSWD, 'utf8'), load(GROUP, 'utf8')]);
  const accounts = parsePasswd(passwdText);
  const groups = parseGroup(groupText);
  const current = userInfo();
  if (!current || typeof current.username !== 'string' || !Number.isSafeInteger(current.uid) || current.uid < 0) throw new Error('Linux setup identity observation is invalid');
  const operator = accounts.get(current.username);
  if (!operator || operator.uid !== current.uid) throw new Error('Linux setup identity does not match the local account database');
  const provider = await inspectProviderSocket(groups, stat);
  const providerGroup = provider.group == null ? null : groups.byName.get(provider.group);
  return Object.freeze({
    protocol: PROTOCOL,
    platform: 'linux',
    applicable: true,
    elevated: current.uid === 0,
    operator: Object.freeze({ name: operator.name, uid: operator.uid, gid: operator.gid }),
    provider,
    ordinaryProviderMember: providerGroup == null ? false : memberOf(operator, providerGroup),
    accounts,
    groups,
  });
}

export async function inspectLinuxLifecycleAuthorityState({
  plan,
  host,
  platform = process.platform,
  environment = process.env,
  invoke = invokeCommand,
} = {}, {
  stat = lstat,
  load = readFile,
} = {}) {
  if (platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform, applicable: false });
  if (!plan || plan.protocol !== 'devbridge/linux-lifecycle-authority-plan-v1') throw new TypeError('Linux lifecycle authority inspection plan is invalid');
  if (!host || host.protocol !== PROTOCOL || host.applicable !== true) throw new TypeError('Linux lifecycle authority host observation is invalid');
  if (typeof invoke !== 'function') throw new TypeError('Linux lifecycle authority inspection invocation contract is invalid');
  if (host.provider?.available !== true || host.provider.group !== plan.service.providerGroup) throw new Error('Linux lifecycle authority provider capability does not match the plan');

  const serviceAccount = host.accounts.get(plan.service.user) ?? null;
  const operatorAccount = host.accounts.get(plan.service.operator) ?? null;
  const readGroup = host.groups.byName.get(plan.service.readGroup) ?? null;
  const coordinationGroup = host.groups.byName.get(plan.service.coordinationGroup) ?? null;
  const providerGroup = host.groups.byName.get(plan.service.providerGroup) ?? null;
  const rootGroup = host.groups.byName.get('root') ?? null;
  if (!operatorAccount || !providerGroup || !rootGroup || rootGroup.gid !== 0) throw new Error('Linux lifecycle authority account/group observation is incomplete');

  const [
    unitInfo,
    unitText,
    protectedRootInfo,
    authorityInfo,
    binInfo,
    runtimeInfo,
    packageInfo,
    nodeInfo,
    packageManifestInfo,
    serviceEntryInfo,
    runRootInfo,
    readDirectoryInfo,
    mutationDirectoryInfo,
    ownership,
    service,
  ] = await Promise.all([
    optionalLstat(plan.service.unitPath, stat),
    load(plan.service.unitPath, 'utf8').catch((error) => { if (error?.code === 'ENOENT') return null; throw error; }),
    optionalLstat(plan.protectedRoot, stat),
    optionalLstat(plan.authorityDirectory, stat),
    optionalLstat(plan.runtime.binDirectory, stat),
    optionalLstat(plan.runtime.runtimeDirectory, stat),
    optionalLstat(plan.runtime.packageDirectory, stat),
    optionalLstat(plan.runtime.nodeExecutable, stat),
    optionalLstat(plan.runtime.packageManifest, stat),
    optionalLstat(plan.runtime.serviceEntry, stat),
    optionalLstat(plan.endpoints.runRoot, stat),
    optionalLstat(plan.endpoints.read.directory, stat),
    optionalLstat(plan.endpoints.mutation.directory, stat),
    inspectOwnership(plan, stat, load),
    inspectSystemdService(plan, { invoke, environment }),
  ]);

  const serviceUid = serviceAccount?.uid ?? -1;
  const readGid = readGroup?.gid ?? -1;
  const coordinationGid = coordinationGroup?.gid ?? -1;
  const unitExact = unitText === plan.service.unit;
  const supplementary = new Set(service.supplementaryGroups ?? []);
  const expectedSupplementary = new Set([plan.service.coordinationGroup, plan.service.providerGroup]);
  const configuredGroupsExact = supplementary.size === expectedSupplementary.size && [...supplementary].every((entry) => expectedSupplementary.has(entry));
  const allowedServiceGroups = new Set([plan.service.readGroup, plan.service.coordinationGroup, plan.service.providerGroup]);
  const unexpectedServiceGroups = groupsFor(serviceAccount, host.groups).filter((entry) => !allowedServiceGroups.has(entry));

  return Object.freeze({
    protocol: PROTOCOL,
    platform: 'linux',
    applicable: true,
    authorityIdentity: plan.authorityIdentity,
    accounts: Object.freeze({
      service: Object.freeze({
        exists: serviceAccount != null,
        nonRoot: serviceAccount != null && serviceAccount.uid !== 0,
        home: serviceAccount?.home === plan.service.account.home,
        shell: serviceAccount?.shell === plan.service.account.shell,
        primaryReadGroup: serviceAccount != null && readGroup != null && serviceAccount.gid === readGroup.gid,
        unexpectedGroups: Object.freeze(unexpectedServiceGroups),
      }),
      readGroup: Object.freeze({ exists: readGroup != null, service: memberOf(serviceAccount, readGroup), operator: memberOf(operatorAccount, readGroup) }),
      coordinationGroup: Object.freeze({ exists: coordinationGroup != null, service: memberOf(serviceAccount, coordinationGroup), operator: memberOf(operatorAccount, coordinationGroup) }),
      providerGroup: Object.freeze({ exists: true, service: memberOf(serviceAccount, providerGroup), operator: memberOf(operatorAccount, providerGroup) }),
    }),
    service: Object.freeze({
      ...service,
      unitFile: Object.freeze({ exists: unitInfo != null, real: realFile(unitInfo), rootOwned: unitInfo?.uid === 0 && unitInfo?.gid === 0, mode: unitInfo == null ? false : mode(unitInfo) === 0o644, exact: unitExact }),
      identity: service.exists === true && service.user === plan.service.user && service.group === plan.service.readGroup,
      groups: service.exists === true && configuredGroupsExact,
      fragment: service.exists === true && service.fragmentPath === plan.service.unitPath,
    }),
    filesystem: Object.freeze({
      protectedRoot: filePolicy(protectedRootInfo, { uid: 0, gid: 0, mode: plan.access.protectedRoot.mode, kind: 'directory' }),
      authorityState: filePolicy(authorityInfo, { uid: serviceUid, gid: 0, mode: plan.access.authorityState.mode, kind: 'directory' }),
      binDirectory: filePolicy(binInfo, { uid: 0, gid: 0, mode: plan.access.protectedRuntime.directoryMode, kind: 'directory' }),
      runtimeDirectory: filePolicy(runtimeInfo, { uid: 0, gid: 0, mode: plan.access.protectedRuntime.directoryMode, kind: 'directory' }),
      packageDirectory: filePolicy(packageInfo, { uid: 0, gid: 0, mode: plan.access.protectedRuntime.directoryMode, kind: 'directory' }),
      nodeExecutable: filePolicy(nodeInfo, { uid: 0, gid: 0, mode: plan.access.protectedRuntime.executableMode, kind: 'file' }),
      packageManifest: filePolicy(packageManifestInfo, { uid: 0, gid: 0, mode: plan.access.protectedRuntime.fileMode, kind: 'file' }),
      serviceEntry: filePolicy(serviceEntryInfo, { uid: 0, gid: 0, mode: plan.access.protectedRuntime.fileMode, kind: 'file' }),
      ownershipManifest: filePolicy(ownership.info, { uid: 0, gid: 0, mode: plan.access.ownershipManifest.mode, kind: 'file' }),
      runRoot: filePolicy(runRootInfo, { uid: 0, gid: 0, mode: 0o755, kind: 'directory' }),
      readDirectory: filePolicy(readDirectoryInfo, { uid: serviceUid, gid: readGid, mode: plan.endpoints.read.mode, kind: 'directory' }),
      mutationDirectory: filePolicy(mutationDirectoryInfo, { uid: serviceUid, gid: 0, mode: plan.endpoints.mutation.mode, kind: 'directory' }),
    }),
    ownership: Object.freeze({ exists: ownership.exists, valid: ownership.valid, record: ownership.record }),
    provider: Object.freeze({ socket: host.provider.socket, group: host.provider.group, operatorMember: memberOf(operatorAccount, providerGroup), serviceMember: memberOf(serviceAccount, providerGroup) }),
    coordination: Object.freeze({ group: plan.service.coordinationGroup, gid: coordinationGid }),
  });
}

export {
  OWNERSHIP_PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
  PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL,
  PROVIDER_SOCKETS as LINUX_LIFECYCLE_AUTHORITY_PROVIDER_SOCKETS,
};
