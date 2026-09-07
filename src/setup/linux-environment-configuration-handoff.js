import { lstat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  environmentConfigurationAuthorityIdentity,
} from '../runtime/environment-configuration-authority-transport.js';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_MAX_BYTES,
  normalizeEnvironmentProfileConfigurationRecord,
} from '../runtime/environment-profile-configuration.js';
import { ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY } from '../state/environment-profile-configuration-state-store.js';
import { readEnvironmentProfileConfigurationRecord } from './environment-profile-configuration-record.js';
import {
  readLinuxTransferredFile,
  transferLinuxProtectedFile,
} from './linux-protected-storage.js';

const PROTOCOL = 'devbridge/linux-environment-configuration-handoff-v1';
const MAX_DOCUMENT_BYTES = ENVIRONMENT_PROFILE_CONFIGURATION_MAX_BYTES + 64 * 1024;
const ROOT_MODE = 0o755;
const DIRECTORY_MODE = 0o3770;
const FILE_MODE = 0o640;

function absolute(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096 || /[\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value) {
    throw new TypeError(`${name} must be a normalized absolute Linux path`);
  }
  return value;
}

function numeric(value, name, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new TypeError(`${name} is invalid`);
  return value;
}

function mode(info) {
  return info.mode & 0o7777;
}

function real(info, kind) {
  return info != null && !info.isSymbolicLink() && (kind === 'directory' ? info.isDirectory() : info.isFile());
}

function exactRecord(value, expected) {
  const record = normalizeEnvironmentProfileConfigurationRecord(value);
  if (record.revision !== expected.revision || record.digest !== expected.digest) {
    throw new Error('accepted environment configuration subject changed');
  }
  return record;
}

function expectedRecord(value) {
  const record = normalizeEnvironmentProfileConfigurationRecord(value);
  return Object.freeze({ revision: record.revision, digest: record.digest, record });
}

function document(content) {
  let value;
  try { value = JSON.parse(content.toString('utf8')); }
  catch { throw new Error('accepted environment configuration handoff is invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY)) {
    throw new Error('accepted environment configuration handoff contains unexpected state');
  }
  return normalizeEnvironmentProfileConfigurationRecord(value[ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY]);
}

export function linuxEnvironmentConfigurationHandoffTopology({
  stateDirectory,
  runDirectory = '/run/devbridge',
} = {}) {
  const state = absolute(stateDirectory, 'environment configuration handoff state directory');
  const run = absolute(runDirectory, 'environment configuration handoff run directory');
  if (run === '/' || !run.startsWith('/run/')) throw new TypeError('environment configuration handoff run directory is invalid');
  const identity = environmentConfigurationAuthorityIdentity(state, { platform: 'linux' });
  const root = path.posix.join(run, identity);
  const endpointDirectory = path.posix.join(root, 'configuration');
  const handoffDirectory = path.posix.join(root, 'handoff');
  return Object.freeze({
    protocol: PROTOCOL,
    identity,
    root,
    endpointDirectory,
    handoffDirectory,
    record: path.posix.join(handoffDirectory, 'state.json'),
    source: path.posix.join(state, 'environment-profile-configuration', 'state.json'),
  });
}

function rootDirectory(info, name) {
  if (!real(info, 'directory') || info.uid !== 0 || info.gid !== 0 || mode(info) !== ROOT_MODE) {
    throw new Error(`${name} authority is invalid`);
  }
}

function sharedDirectory(info) {
  if (!real(info, 'directory') || info.uid !== 0 || info.gid < 1 || mode(info) !== DIRECTORY_MODE) {
    throw new Error('environment configuration handoff directory authority is invalid');
  }
  return Object.freeze({ groupId: info.gid });
}

function sourceFile(info, userId) {
  if (!real(info, 'file') || info.uid !== userId || info.nlink !== 1 || info.size < 2 || info.size > MAX_DOCUMENT_BYTES) {
    throw new Error('accepted environment configuration source authority is invalid');
  }
  return Object.freeze({
    ownerId: info.uid,
    groupId: info.gid,
    mode: mode(info),
    size: info.size,
  });
}

export async function publishLinuxEnvironmentConfigurationHandoff({
  stateDirectory,
  record,
  runDirectory = '/run/devbridge',
  userId = process.getuid?.(),
} = {}, {
  inspect = lstat,
  read = readLinuxTransferredFile,
  transfer = transferLinuxProtectedFile,
  recordReader = readEnvironmentProfileConfigurationRecord,
} = {}) {
  const selectedUser = numeric(userId, 'environment configuration handoff user identity');
  const expected = expectedRecord(record);
  const topology = linuxEnvironmentConfigurationHandoffTopology({ stateDirectory, runDirectory });
  if ([inspect, read, transfer, recordReader].some((port) => typeof port !== 'function')) {
    throw new TypeError('environment configuration handoff publication ports are invalid');
  }
  exactRecord(await recordReader({ stateDirectory }), expected);
  const [rootInfo, directoryInfo, inputInfo] = await Promise.all([
    inspect(topology.root),
    inspect(topology.handoffDirectory),
    inspect(topology.source),
  ]);
  rootDirectory(rootInfo, 'environment configuration handoff root');
  const shared = sharedDirectory(directoryInfo);
  const input = sourceFile(inputInfo, selectedUser);
  const measured = await read({
    contract: Object.freeze({
      path: topology.source,
      ownerId: input.ownerId,
      groupId: input.groupId,
      mode: input.mode,
    }),
    size: input.size,
    maximumBytes: MAX_DOCUMENT_BYTES,
  });
  const measuredRecord = document(measured.content);
  exactRecord(measuredRecord, expected);
  const installed = await transfer({
    input: Object.freeze({ path: topology.source, size: measured.size, digest: measured.digest }),
    output: Object.freeze({ path: topology.record, ownerId: selectedUser, groupId: shared.groupId, mode: FILE_MODE }),
    parent: Object.freeze({ path: topology.handoffDirectory, ownerId: 0, groupId: shared.groupId, mode: DIRECTORY_MODE }),
    creatorIds: Object.freeze({ ownerId: selectedUser, groupId: shared.groupId }),
    maximumBytes: MAX_DOCUMENT_BYTES,
  });
  if (installed?.path !== topology.record || installed?.size !== measured.size || installed?.digest !== measured.digest
      || typeof installed.changed !== 'boolean') {
    throw new Error('environment configuration handoff publication evidence is invalid');
  }
  exactRecord(await recordReader({ stateDirectory }), expected);
  return Object.freeze({
    protocol: PROTOCOL,
    ready: true,
    changed: installed.changed,
    revision: expected.revision,
    subject: expected.digest,
  });
}

export async function readLinuxEnvironmentConfigurationHandoff({
  stateDirectory,
  runDirectory = '/run/devbridge',
  serviceUserId = process.getuid?.(),
} = {}, {
  inspect = lstat,
  read = readLinuxTransferredFile,
} = {}) {
  const selectedService = numeric(serviceUserId, 'environment configuration service identity');
  const topology = linuxEnvironmentConfigurationHandoffTopology({ stateDirectory, runDirectory });
  if (typeof inspect !== 'function' || typeof read !== 'function') throw new TypeError('environment configuration handoff read ports are invalid');
  const [rootInfo, directoryInfo, fileInfo] = await Promise.all([
    inspect(topology.root),
    inspect(topology.handoffDirectory),
    inspect(topology.record),
  ]);
  rootDirectory(rootInfo, 'environment configuration handoff root');
  const shared = sharedDirectory(directoryInfo);
  if (!real(fileInfo, 'file') || fileInfo.uid < 1 || fileInfo.uid === selectedService
      || fileInfo.gid !== shared.groupId || mode(fileInfo) !== FILE_MODE || fileInfo.nlink !== 1
      || fileInfo.size < 2 || fileInfo.size > MAX_DOCUMENT_BYTES) {
    throw new Error('accepted environment configuration handoff authority is invalid');
  }
  const loaded = await read({
    contract: Object.freeze({
      path: topology.record,
      ownerId: fileInfo.uid,
      groupId: shared.groupId,
      mode: FILE_MODE,
    }),
    size: fileInfo.size,
    maximumBytes: MAX_DOCUMENT_BYTES,
  });
  return document(loaded.content);
}

export { PROTOCOL as LINUX_ENVIRONMENT_CONFIGURATION_HANDOFF_PROTOCOL };
