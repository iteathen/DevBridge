import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  ENVIRONMENT_ACTIVITY_POLICY_MAX_BYTES,
  loadEnvironmentActivityPolicy,
  normalizeEnvironmentActivityPolicy,
} from '../runtime/environment-activity-policy.js';
import {
  environmentActivityAuthorityIdentity,
} from '../runtime/environment-activity-authority-transport.js';
import {
  readLinuxTransferredFile,
  transferLinuxProtectedFile,
} from './linux-protected-storage.js';

const PROTOCOL = 'devbridge/linux-environment-activity-handoff-v1';
const ROOT_MODE = 0o755;
const ENDPOINT_MODE = 0o2750;
const DIRECTORY_MODE = 0o3770;
const SOURCE_MODE = 0o600;
const FILE_MODE = 0o640;

function absolute(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096 || /[\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value) {
    throw new TypeError(`${name} must be a normalized absolute Linux path`);
  }
  return value;
}

function numeric(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`);
  return value;
}

function mode(info) {
  return info.mode & 0o7777;
}

function real(info, kind) {
  return info != null && !info.isSymbolicLink() && (kind === 'directory' ? info.isDirectory() : info.isFile());
}

function samePolicy(left, right) {
  return JSON.stringify(normalizeEnvironmentActivityPolicy(left)) === JSON.stringify(normalizeEnvironmentActivityPolicy(right));
}

function policyFrom(content) {
  let raw;
  try { raw = JSON.parse(content.toString('utf8')); }
  catch { throw new Error('environment activity handoff is invalid JSON'); }
  return normalizeEnvironmentActivityPolicy(raw);
}

function subject(content) {
  return createHash('sha256').update(content).digest('hex');
}

function rootDirectory(info) {
  if (!real(info, 'directory') || info.uid !== 0 || info.gid !== 0 || mode(info) !== ROOT_MODE) {
    throw new Error('environment activity handoff root authority is invalid');
  }
}

function endpointDirectory(info) {
  if (!real(info, 'directory') || info.uid < 1 || info.gid < 1 || mode(info) !== ENDPOINT_MODE) {
    throw new Error('environment activity endpoint directory authority is invalid');
  }
  return Object.freeze({ ownerId: info.uid, groupId: info.gid });
}

function handoffDirectory(info, identity) {
  if (!real(info, 'directory') || info.uid !== 0 || info.gid !== identity.groupId || mode(info) !== DIRECTORY_MODE) {
    throw new Error('environment activity handoff directory authority is invalid');
  }
}

export function linuxEnvironmentActivityHandoffTopology({
  stateDirectory,
  authorityDirectory = null,
  runDirectory = '/run/devbridge',
} = {}) {
  const state = absolute(stateDirectory, 'environment activity handoff state directory');
  const authority = authorityDirectory == null
    ? null
    : absolute(authorityDirectory, 'environment activity handoff authority directory');
  const run = absolute(runDirectory, 'environment activity handoff run directory');
  if (run === '/' || !run.startsWith('/run/')) throw new TypeError('environment activity handoff run directory is invalid');
  const identity = environmentActivityAuthorityIdentity(state, { platform: 'linux' });
  const root = path.posix.join(run, identity);
  const endpointDirectoryPath = path.posix.join(root, 'activity');
  const handoffDirectoryPath = path.posix.join(root, 'handoff');
  return Object.freeze({
    protocol: PROTOCOL,
    identity,
    root,
    endpointDirectory: endpointDirectoryPath,
    handoffDirectory: handoffDirectoryPath,
    record: path.posix.join(handoffDirectoryPath, 'policy.json'),
    source: authority == null ? null : path.posix.join(authority, 'environment-activity', 'policy.json'),
  });
}

export async function publishLinuxEnvironmentActivityHandoff({
  stateDirectory,
  authorityDirectory,
  policy,
  runDirectory = '/run/devbridge',
  serviceUserId = process.getuid?.(),
} = {}, {
  inspect = lstat,
  read = readLinuxTransferredFile,
  transfer = transferLinuxProtectedFile,
  policyReader = loadEnvironmentActivityPolicy,
} = {}) {
  const selectedService = numeric(serviceUserId, 'environment activity service identity');
  const expected = normalizeEnvironmentActivityPolicy(policy);
  const topology = linuxEnvironmentActivityHandoffTopology({ stateDirectory, authorityDirectory, runDirectory });
  if (topology.source == null) throw new TypeError('environment activity handoff authority directory is required for publication');
  if ([inspect, read, transfer, policyReader].some((port) => typeof port !== 'function')) {
    throw new TypeError('environment activity handoff publication ports are invalid');
  }
  const before = await policyReader(authorityDirectory);
  if (before == null || !samePolicy(before, expected)) throw new Error('protected environment activity policy changed');
  const [rootInfo, endpointInfo, directoryInfo, sourceInfo] = await Promise.all([
    inspect(topology.root),
    inspect(topology.endpointDirectory),
    inspect(topology.handoffDirectory),
    inspect(topology.source),
  ]);
  rootDirectory(rootInfo);
  const endpoint = endpointDirectory(endpointInfo);
  if (endpoint.ownerId !== selectedService) throw new Error('environment activity service identity changed');
  handoffDirectory(directoryInfo, endpoint);
  if (!real(sourceInfo, 'file') || sourceInfo.uid !== selectedService || sourceInfo.gid !== endpoint.groupId
      || mode(sourceInfo) !== SOURCE_MODE || sourceInfo.nlink !== 1
      || sourceInfo.size < 2 || sourceInfo.size > ENVIRONMENT_ACTIVITY_POLICY_MAX_BYTES) {
    throw new Error('protected environment activity policy authority is invalid');
  }
  const measured = await read({
    contract: Object.freeze({ path: topology.source, ownerId: selectedService, groupId: endpoint.groupId, mode: SOURCE_MODE }),
    size: sourceInfo.size,
    maximumBytes: ENVIRONMENT_ACTIVITY_POLICY_MAX_BYTES,
  });
  if (!samePolicy(policyFrom(measured.content), expected)) throw new Error('protected environment activity policy bytes changed');
  const installed = await transfer({
    input: Object.freeze({ path: topology.source, size: measured.size, digest: measured.digest }),
    output: Object.freeze({ path: topology.record, ownerId: selectedService, groupId: endpoint.groupId, mode: FILE_MODE }),
    parent: Object.freeze({ path: topology.handoffDirectory, ownerId: 0, groupId: endpoint.groupId, mode: DIRECTORY_MODE }),
    creatorIds: Object.freeze({ ownerId: selectedService, groupId: endpoint.groupId }),
    maximumBytes: ENVIRONMENT_ACTIVITY_POLICY_MAX_BYTES,
  });
  if (installed?.path !== topology.record || installed?.size !== measured.size || installed?.digest !== measured.digest
      || typeof installed.changed !== 'boolean') {
    throw new Error('environment activity handoff publication evidence is invalid');
  }
  const after = await policyReader(authorityDirectory);
  if (after == null || !samePolicy(after, expected)) throw new Error('protected environment activity policy changed');
  return Object.freeze({ protocol: PROTOCOL, ready: true, changed: installed.changed, subject: measured.digest });
}

export async function readLinuxEnvironmentActivityHandoff({
  stateDirectory,
  runDirectory = '/run/devbridge',
} = {}, {
  inspect = lstat,
  read = readLinuxTransferredFile,
} = {}) {
  const topology = linuxEnvironmentActivityHandoffTopology({ stateDirectory, runDirectory });
  if (typeof inspect !== 'function' || typeof read !== 'function') throw new TypeError('environment activity handoff read ports are invalid');
  const [rootInfo, endpointInfo, directoryInfo, fileInfo] = await Promise.all([
    inspect(topology.root),
    inspect(topology.endpointDirectory),
    inspect(topology.handoffDirectory),
    inspect(topology.record),
  ]);
  rootDirectory(rootInfo);
  const endpoint = endpointDirectory(endpointInfo);
  handoffDirectory(directoryInfo, endpoint);
  if (!real(fileInfo, 'file') || fileInfo.uid !== endpoint.ownerId || fileInfo.gid !== endpoint.groupId
      || mode(fileInfo) !== FILE_MODE || fileInfo.nlink !== 1
      || fileInfo.size < 2 || fileInfo.size > ENVIRONMENT_ACTIVITY_POLICY_MAX_BYTES) {
    throw new Error('environment activity handoff authority is invalid');
  }
  const loaded = await read({
    contract: Object.freeze({ path: topology.record, ownerId: endpoint.ownerId, groupId: endpoint.groupId, mode: FILE_MODE }),
    size: fileInfo.size,
    maximumBytes: ENVIRONMENT_ACTIVITY_POLICY_MAX_BYTES,
  });
  const policy = policyFrom(loaded.content);
  return Object.freeze({ protocol: PROTOCOL, policy, subject: subject(loaded.content) });
}

export { PROTOCOL as LINUX_ENVIRONMENT_ACTIVITY_HANDOFF_PROTOCOL };
