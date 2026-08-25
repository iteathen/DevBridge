import path from 'node:path';
import {
  environmentLifecycleAuthorityEndpoint,
  environmentLifecycleAuthorityIdentity,
} from '../runtime/environment-lifecycle-authority-transport.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-plan-v1';
const WINDOWS_SID = /^S-1-(?:\d+-)+\d+$/u;
const SERVICE_PREFIX = 'DevBridgeLifecycle-';

export const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544';
export const WINDOWS_HYPERV_ADMINISTRATORS_SID = 'S-1-5-32-578';
export const WINDOWS_SYSTEM_SID = 'S-1-5-18';

function absoluteWindowsPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.win32.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute Windows path`);
  }
  return path.win32.resolve(value);
}

function windowsSid(value, name) {
  if (typeof value !== 'string' || !WINDOWS_SID.test(value)) throw new TypeError(`${name} must be a Windows SID`);
  return value;
}

function under(root, ...segments) {
  const target = path.win32.resolve(root, ...segments);
  const relative = path.win32.relative(root, target);
  if (relative === '' || relative.startsWith(`..${path.win32.sep}`) || relative === '..' || path.win32.isAbsolute(relative)) {
    throw new Error('Windows lifecycle authority protected path escaped its root');
  }
  return target;
}

function clientAce(sid) {
  return Object.freeze({ principal: sid, rights: 'read-write' });
}

function serverAce(principal) {
  return Object.freeze({ principal, rights: 'full-control' });
}

export function createWindowsLifecycleAuthorityPlan({
  stateDirectory,
  programDataDirectory,
  operatorSid,
} = {}) {
  const state = absoluteWindowsPath(stateDirectory, 'Windows lifecycle authority stateDirectory');
  const programData = absoluteWindowsPath(programDataDirectory, 'Windows lifecycle authority programDataDirectory');
  const operator = windowsSid(operatorSid, 'Windows lifecycle authority operatorSid');
  const authorityIdentity = environmentLifecycleAuthorityIdentity(state, { platform: 'win32' });
  const serviceName = `${SERVICE_PREFIX}${authorityIdentity}`;
  const serviceAccount = `NT SERVICE\\${serviceName}`;
  const protectedRoot = under(programData, 'DevBridge', 'lifecycle-authority', authorityIdentity);
  const authorityDirectory = under(protectedRoot, 'state');
  const binDirectory = under(protectedRoot, 'bin');
  const runtimeDirectory = under(protectedRoot, 'runtime');
  const packageDirectory = under(runtimeDirectory, 'package');
  const serviceHostSource = under(runtimeDirectory, 'windows-lifecycle-authority-host.cs');
  const serviceHostExecutable = under(binDirectory, 'devbridge-lifecycle-authority-host.exe');
  const nodeExecutable = under(binDirectory, 'node.exe');
  const workerEntry = under(packageDirectory, 'src', 'entry', 'windows-lifecycle-authority-worker.mjs');
  const packageManifest = under(packageDirectory, 'package.json');
  const ownershipManifest = under(protectedRoot, 'ownership.json');
  const readEndpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'read', platform: 'win32' });
  const mutationEndpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'mutation', platform: 'win32' });

  return Object.freeze({
    protocol: PROTOCOL,
    authorityIdentity,
    stateDirectory: state,
    protectedRoot,
    authorityDirectory,
    ownershipManifest,
    runtime: Object.freeze({
      binDirectory,
      runtimeDirectory,
      packageDirectory,
      packageManifest,
      serviceHostSource,
      serviceHostExecutable,
      nodeExecutable,
      workerEntry,
    }),
    service: Object.freeze({
      name: serviceName,
      displayName: `DevBridge Environment Lifecycle Authority ${authorityIdentity.slice(0, 12)}`,
      account: serviceAccount,
      sidType: 'unrestricted',
      start: 'automatic',
      failureAction: 'restart',
      hyperVGroupSid: WINDOWS_HYPERV_ADMINISTRATORS_SID,
    }),
    endpoints: Object.freeze({
      read: Object.freeze({ endpoint: readEndpoint, pipeName: path.win32.basename(readEndpoint) }),
      mutation: Object.freeze({ endpoint: mutationEndpoint, pipeName: path.win32.basename(mutationEndpoint) }),
    }),
    acl: Object.freeze({
      protectedRoot: Object.freeze({
        administrators: Object.freeze({ principal: WINDOWS_ADMINISTRATORS_SID, rights: 'full-control' }),
        system: Object.freeze({ principal: WINDOWS_SYSTEM_SID, rights: 'full-control' }),
        service: Object.freeze({ principal: serviceAccount, rights: 'read-execute' }),
        ordinaryUserWrite: false,
      }),
      authorityState: Object.freeze({
        administrators: Object.freeze({ principal: WINDOWS_ADMINISTRATORS_SID, rights: 'full-control' }),
        system: Object.freeze({ principal: WINDOWS_SYSTEM_SID, rights: 'full-control' }),
        service: Object.freeze({ principal: serviceAccount, rights: 'modify' }),
        ordinaryUserWrite: false,
      }),
      readPipe: Object.freeze({
        owner: serviceAccount,
        servers: Object.freeze([serverAce(serviceAccount), serverAce(WINDOWS_SYSTEM_SID)]),
        clients: Object.freeze([clientAce(operator), clientAce(WINDOWS_ADMINISTRATORS_SID)]),
      }),
      mutationPipe: Object.freeze({
        owner: serviceAccount,
        servers: Object.freeze([serverAce(serviceAccount), serverAce(WINDOWS_SYSTEM_SID)]),
        clients: Object.freeze([clientAce(WINDOWS_ADMINISTRATORS_SID)]),
      }),
    }),
  });
}

export { PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL };
