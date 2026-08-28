import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createActivityGate } from '../runtime/activity-gate.js';
import { environmentLifecycleAuthorityIdentity } from '../runtime/environment-lifecycle-authority-transport.js';
import { createLinuxFileLease } from '../runtime/linux-file-lease.js';
import { createLinuxIntentStore } from '../runtime/linux-intent-store.js';
import { createLinuxLifecycleAuthorityPlan } from '../setup/linux-lifecycle-authority.js';
import { normalizeLinuxLifecycleAuthorityOwnershipRecord } from '../setup/linux-lifecycle-authority-records.js';
import { readLinuxProtectedFile } from '../setup/linux-protected-storage.js';

const MAX_OWNERSHIP_BYTES = 32 * 1024;

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function absoluteLinuxPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value || value === '/') {
    throw new TypeError(`${name} must be a normalized absolute Linux path`);
  }
  return value;
}

function runRoot(value) {
  const selected = absoluteLinuxPath(value, 'Linux activity runDirectory');
  if (selected === '/run' || !selected.startsWith('/run/') || /[\\%\s]/u.test(selected)) {
    throw new TypeError('Linux activity runDirectory contains unsupported topology syntax');
  }
  return selected;
}

function identifier(value, name, { allowRoot = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowRoot ? 0 : 1)) throw new TypeError(`${name} is invalid`);
  return value;
}

function mode(info) {
  return info.mode & 0o7777;
}

function sameEntry(left, right) {
  return left != null && right != null
    && left.dev === right.dev && left.ino === right.ino
    && left.uid === right.uid && left.gid === right.gid
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function entry(target, { kind, ownerId, groupId, expectedMode, singleLink = false }, stat) {
  const observed = await stat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  const correctKind = observed != null && !observed.isSymbolicLink()
    && (kind === 'directory' ? observed.isDirectory() : observed.isFile());
  if (!correctKind || observed.uid !== ownerId || observed.gid !== groupId
      || mode(observed) !== expectedMode || (singleLink && observed.nlink !== 1)) {
    throw new Error('Linux activity topology policy is invalid');
  }
  return observed;
}

function processIdentity(ports) {
  const uid = identifier(ports.getUid(), 'Linux activity process uid');
  const effectiveUid = identifier(ports.getEffectiveUid(), 'Linux activity process effective uid');
  const gid = identifier(ports.getGid(), 'Linux activity process gid');
  const effectiveGid = identifier(ports.getEffectiveGid(), 'Linux activity process effective gid');
  const rawGroups = ports.getGroups();
  if (!Array.isArray(rawGroups) || rawGroups.length < 1 || rawGroups.length > 256) {
    throw new Error('Linux activity process groups are invalid');
  }
  const groups = [...new Set(rawGroups.map((value) => identifier(value, 'Linux activity process group', { allowRoot: true })))]
    .sort((left, right) => left - right);
  if (uid !== effectiveUid || gid !== effectiveGid) throw new Error('Linux activity process identity is not stable');
  return Object.freeze({ uid, gid, groups: Object.freeze(groups) });
}

function topologyPaths(stateDirectory, runDirectory) {
  const authorityIdentity = environmentLifecycleAuthorityIdentity(stateDirectory, { platform: 'linux' });
  const runRoot = path.posix.join(runDirectory, authorityIdentity);
  const governance = path.posix.join(runRoot, 'governance');
  return Object.freeze({
    authorityIdentity,
    parent: runDirectory,
    runRoot,
    readDirectory: path.posix.join(runRoot, 'read'),
    governance,
    lock: path.posix.join(governance, 'activity.lock'),
    shared: path.posix.join(governance, 'shared.intent'),
    exclusive: path.posix.join(governance, 'exclusive.intent'),
  });
}

async function topologyIdentity(paths, expected, stat) {
  await entry(paths.parent, { kind: 'directory', ownerId: 0, groupId: 0, expectedMode: 0o755 }, stat);
  await entry(paths.runRoot, { kind: 'directory', ownerId: 0, groupId: 0, expectedMode: 0o755 }, stat);
  const read = await stat(paths.readDirectory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  const governance = await stat(paths.governance).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (read == null || read.isSymbolicLink() || !read.isDirectory() || mode(read) !== 0o750
      || governance == null || governance.isSymbolicLink() || !governance.isDirectory()
      || governance.uid !== 0 || mode(governance) !== 0o3770) {
    throw new Error('Linux activity topology policy is invalid');
  }
  const serviceUid = identifier(read.uid, 'Linux activity service uid');
  const readGid = identifier(read.gid, 'Linux activity read gid');
  const coordinationGid = identifier(governance.gid, 'Linux activity coordination gid');
  if (readGid === coordinationGid) throw new Error('Linux activity topology identities alias');
  if (expected != null && (serviceUid !== expected.serviceUid
      || readGid !== expected.readGid || coordinationGid !== expected.coordinationGid)) {
    throw new Error('Linux activity topology identity changed');
  }
  await entry(paths.lock, { kind: 'file', ownerId: 0, groupId: coordinationGid, expectedMode: 0o660, singleLink: true }, stat);
  return Object.freeze({ serviceUid, readGid, coordinationGid });
}

async function protectedIdentity({ stateDirectory, authorityDirectory, paths }, ports) {
  const current = processIdentity(ports);
  const protectedRoot = path.posix.dirname(authorityDirectory);
  const storageRoot = path.posix.dirname(protectedRoot);
  const varLibDirectory = path.posix.dirname(storageRoot);
  const ownershipPath = path.posix.join(protectedRoot, 'ownership.json');
  await entry(protectedRoot, { kind: 'directory', ownerId: 0, groupId: 0, expectedMode: 0o755 }, ports.stat);
  await entry(authorityDirectory, { kind: 'directory', ownerId: current.uid, groupId: 0, expectedMode: 0o700 }, ports.stat);
  const before = await entry(ownershipPath, { kind: 'file', ownerId: 0, groupId: 0, expectedMode: 0o444, singleLink: true }, ports.stat);
  const loaded = await ports.loadProtected({
    contract: Object.freeze({ path: ownershipPath, ownerId: 0, groupId: 0, mode: 0o444 }),
    maximumBytes: MAX_OWNERSHIP_BYTES,
  }, { stat: ports.stat, load: ports.load });
  const after = await entry(ownershipPath, { kind: 'file', ownerId: 0, groupId: 0, expectedMode: 0o444, singleLink: true }, ports.stat);
  if (!sameEntry(before, after) || !Buffer.isBuffer(loaded?.content) || loaded.size !== loaded.content.length
      || loaded.content.at(-1) !== 0x0a || loaded.content.subarray(0, -1).includes(0x0a)) {
    throw new Error('Linux activity ownership evidence is invalid');
  }
  let raw;
  try { raw = JSON.parse(loaded.content.subarray(0, -1).toString('utf8')); }
  catch { throw new Error('Linux activity ownership evidence is invalid'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Linux activity ownership evidence is invalid');
  const plan = createLinuxLifecycleAuthorityPlan({
    stateDirectory,
    operatorName: raw.operatorName,
    managementGroup: raw.managementGroup,
    varLibDirectory,
    runDirectory: paths.parent,
  });
  if (plan.authorityDirectory !== authorityDirectory || plan.ownershipManifest !== ownershipPath
      || plan.authorityIdentity !== paths.authorityIdentity) {
    throw new Error('Linux activity ownership topology is invalid');
  }
  const ownership = normalizeLinuxLifecycleAuthorityOwnershipRecord(raw, plan);
  const canonical = Buffer.from(`${JSON.stringify(ownership)}\n`, 'utf8');
  if (!loaded.content.equals(canonical) || ownership.localIdentity == null
      || ownership.activeGeneration == null || ownership.stagedGeneration != null) {
    throw new Error('Linux activity ownership evidence is not current');
  }
  const identity = ownership.localIdentity;
  if (current.uid !== identity.serviceUid || current.gid !== identity.readGid
      || !current.groups.includes(identity.coordinationGid)) {
    throw new Error('Linux activity process lacks its bound identity');
  }
  await topologyIdentity(paths, identity, ports.stat);
  return Object.freeze({ ...identity, current });
}

async function ordinaryIdentity({ paths }, ports) {
  const current = processIdentity(ports);
  const topology = await topologyIdentity(paths, null, ports.stat);
  if (current.uid === topology.serviceUid
      || !current.groups.includes(topology.readGid)
      || !current.groups.includes(topology.coordinationGid)) {
    throw new Error('Linux activity process lacks its bound identity');
  }
  return Object.freeze({ operatorUid: current.uid, ...topology, current });
}

function normalizedPorts(value) {
  const input = exactObject(value, new Set([
    'stat', 'load', 'loadProtected', 'getUid', 'getEffectiveUid', 'getGid', 'getEffectiveGid', 'getGroups',
    'gateFactory', 'intentFactory', 'leaseFactory',
  ]), 'Linux activity composition ports');
  const selected = Object.freeze({
    stat: input.stat ?? lstat,
    load: input.load ?? readFile,
    loadProtected: input.loadProtected ?? readLinuxProtectedFile,
    getUid: input.getUid ?? (() => process.getuid()),
    getEffectiveUid: input.getEffectiveUid ?? (() => process.geteuid()),
    getGid: input.getGid ?? (() => process.getgid()),
    getEffectiveGid: input.getEffectiveGid ?? (() => process.getegid()),
    getGroups: input.getGroups ?? (() => process.getgroups()),
    gateFactory: input.gateFactory ?? createActivityGate,
    intentFactory: input.intentFactory ?? createLinuxIntentStore,
    leaseFactory: input.leaseFactory ?? createLinuxFileLease,
  });
  for (const [name, port] of Object.entries(selected)) if (typeof port !== 'function') throw new TypeError(`Linux activity composition ${name} port is invalid`);
  return selected;
}

export async function createLinuxActivityAdmission(raw = {}, dependencies = {}) {
  const input = exactObject(raw, new Set(['access', 'stateDirectory', 'authorityDirectory', 'runDirectory', 'platform']), 'Linux activity composition request');
  const platform = input.platform ?? process.platform;
  if (platform !== 'linux') throw new Error('Linux activity composition is unavailable on this platform');
  if (!['shared', 'exclusive'].includes(input.access)) throw new TypeError('Linux activity composition access is invalid');
  const stateDirectory = absoluteLinuxPath(input.stateDirectory, 'Linux activity stateDirectory');
  const runDirectory = runRoot(input.runDirectory ?? '/run/devbridge');
  const authorityDirectory = input.authorityDirectory == null
    ? null
    : absoluteLinuxPath(input.authorityDirectory, 'Linux activity authorityDirectory');
  if ((input.access === 'exclusive') !== (authorityDirectory != null)) {
    throw new TypeError('Linux activity authorityDirectory must be supplied only for exclusive access');
  }
  const ports = normalizedPorts(dependencies);
  const paths = topologyPaths(stateDirectory, runDirectory);
  const identity = input.access === 'exclusive'
    ? await protectedIdentity({ stateDirectory, authorityDirectory, paths }, ports)
    : await ordinaryIdentity({ paths }, ports);
  const directory = Object.freeze({ path: paths.governance, ownerId: 0, groupId: identity.coordinationGid, mode: 0o3770 });
  const sharedIntent = ports.intentFactory(Object.freeze({
    directory,
    recordPath: paths.shared,
    ownerId: identity.operatorUid,
    groupId: identity.coordinationGid,
  }));
  const exclusiveIntent = ports.intentFactory(Object.freeze({
    directory,
    recordPath: paths.exclusive,
    ownerId: identity.serviceUid,
    groupId: identity.coordinationGid,
  }));
  const lease = ports.leaseFactory(Object.freeze({ subjectPath: paths.lock }));
  const gate = ports.gateFactory(Object.freeze({ sharedIntent, exclusiveIntent, lease }));
  const admission = gate?.[input.access];
  if (!admission || typeof admission.acquire !== 'function'
      || (input.access === 'shared' && typeof admission.reconcile !== 'function')) {
    throw new Error('Linux activity composition did not produce its exact admission contract');
  }
  return admission;
}
