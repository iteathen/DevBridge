import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  environmentLifecycleAuthorityEndpoint,
  environmentLifecycleAuthorityIdentity,
} from '../runtime/environment-lifecycle-authority-transport.js';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-plan-v1';
const WINDOWS_SID = /^S-1-(?:\d+-)+\d+$/u;
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:\\$/u;
const WINDOWS_UNC_ROOT = /^\\\\[^\\]+\\[^\\]+\\$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SERVICE_PREFIX = 'DevBridgeLifecycle-';
const SERVICE_RUNTIME_PREFIX = 'DevBridge lifecycle authority runtime v1';
const RUNTIME_GENERATION_DOMAIN = 'devbridge/windows-lifecycle-authority-runtime-generation-v1';

export const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544';
export const WINDOWS_HYPERV_ADMINISTRATORS_SID = 'S-1-5-32-578';
export const WINDOWS_SYSTEM_SID = 'S-1-5-18';

function absoluteWindowsPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be an absolute Windows path`);
  }
  const normalized = path.win32.normalize(value);
  const root = path.win32.parse(normalized).root;
  const deviceNamespace = normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\');
  if (!path.win32.isAbsolute(normalized) || deviceNamespace || (!WINDOWS_DRIVE_ROOT.test(root) && !WINDOWS_UNC_ROOT.test(root))) {
    throw new TypeError(`${name} must be an absolute Windows path`);
  }
  return path.win32.resolve(normalized);
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

function quoteServiceArgument(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function serviceCommand(fields) {
  return fields.map(quoteServiceArgument).join(' ');
}

function runtimeDigest(value, name) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${name} must be a sha256 digest`);
  return value;
}

function acceptanceEndpoint(authorityIdentity) {
  return `\\\\.\\pipe\\devbridge-environment-${authorityIdentity}-acceptance-v1`;
}

export function windowsLifecycleAuthorityRuntimeGeneration({ packageDigest, nodeDigest } = {}) {
  const packageIdentity = runtimeDigest(packageDigest, 'Windows lifecycle authority package digest');
  const nodeIdentity = runtimeDigest(nodeDigest, 'Windows lifecycle authority Node digest');
  return createHash('sha256')
    .update(`${RUNTIME_GENERATION_DOMAIN}\0`, 'utf8')
    .update(packageIdentity, 'utf8')
    .update('\0', 'utf8')
    .update(nodeIdentity, 'utf8')
    .digest('hex');
}

function runtimeLayout(plan, generation) {
  const identity = runtimeDigest(generation, 'Windows lifecycle authority runtime generation');
  const generationDirectory = under(plan.runtime.generationsDirectory, identity);
  const binDirectory = under(generationDirectory, 'bin');
  const runtimeDirectory = under(generationDirectory, 'runtime');
  const packageDirectory = under(runtimeDirectory, 'package');
  return Object.freeze({
    generationsDirectory: plan.runtime.generationsDirectory,
    generation: identity,
    generationDirectory,
    binDirectory,
    runtimeDirectory,
    packageDirectory,
    packageManifest: under(packageDirectory, 'package.json'),
    serviceHostSource: under(runtimeDirectory, 'windows-lifecycle-authority-host.cs'),
    serviceHostExecutable: under(binDirectory, 'devbridge-lifecycle-authority-host.exe'),
    nodeExecutable: under(binDirectory, 'node.exe'),
    workerEntry: under(packageDirectory, 'src', 'entry', 'windows-lifecycle-authority-worker.mjs'),
  });
}

function commandForRuntime(plan, runtime) {
  return serviceCommand([
    runtime.serviceHostExecutable,
    '--service-name', plan.service.name,
    '--protected-root', plan.protectedRoot,
    '--node', runtime.nodeExecutable,
    '--worker', runtime.workerEntry,
    '--state-directory', plan.stateDirectory,
    '--authority-directory', plan.authorityDirectory,
    '--operator-sid', plan.operatorSid,
    '--read-pipe', plan.endpoints.read.pipeName,
    '--mutation-pipe', plan.endpoints.mutation.pipeName,
    '--acceptance-pipe', plan.endpoints.acceptance.pipeName,
  ]);
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
  const ownershipManifest = under(protectedRoot, 'ownership.json');
  const generationsDirectory = under(protectedRoot, 'generations');
  const readEndpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'read', platform: 'win32' });
  const mutationEndpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'mutation', platform: 'win32' });
  const boundedAcceptanceEndpoint = acceptanceEndpoint(authorityIdentity);
  const readPipeName = path.win32.basename(readEndpoint);
  const mutationPipeName = path.win32.basename(mutationEndpoint);
  const acceptancePipeName = path.win32.basename(boundedAcceptanceEndpoint);

  return Object.freeze({
    protocol: PROTOCOL,
    authorityIdentity,
    operatorSid: operator,
    stateDirectory: state,
    protectedRoot,
    authorityDirectory,
    ownershipManifest,
    serviceCommand: null,
    runtimeEvidence: null,
    runtime: Object.freeze({ generationsDirectory }),
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
      read: Object.freeze({ endpoint: readEndpoint, pipeName: readPipeName }),
      mutation: Object.freeze({ endpoint: mutationEndpoint, pipeName: mutationPipeName }),
      acceptance: Object.freeze({ endpoint: boundedAcceptanceEndpoint, pipeName: acceptancePipeName }),
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
      acceptancePipe: Object.freeze({
        owner: serviceAccount,
        servers: Object.freeze([serverAce(serviceAccount), serverAce(WINDOWS_SYSTEM_SID)]),
        clients: Object.freeze([clientAce(operator), clientAce(WINDOWS_ADMINISTRATORS_SID)]),
      }),
    }),
  });
}

export function bindWindowsLifecycleAuthorityRuntime(plan, { packageDigest, nodeDigest } = {}) {
  if (!plan || typeof plan !== 'object' || plan.protocol !== PROTOCOL) throw new TypeError('Windows lifecycle authority plan is required');
  if (plan.runtimeEvidence != null || plan.serviceCommand != null || plan?.runtime?.generation != null || plan?.service?.description != null) {
    throw new Error('Windows lifecycle authority runtime evidence is already bound');
  }
  const packageIdentity = runtimeDigest(packageDigest, 'Windows lifecycle authority package digest');
  const nodeIdentity = runtimeDigest(nodeDigest, 'Windows lifecycle authority Node digest');
  const generation = windowsLifecycleAuthorityRuntimeGeneration({ packageDigest: packageIdentity, nodeDigest: nodeIdentity });
  const runtime = runtimeLayout(plan, generation);
  const runtimeEvidence = Object.freeze({ packageDigest: packageIdentity, nodeDigest: nodeIdentity });
  return Object.freeze({
    ...plan,
    serviceCommand: commandForRuntime(plan, runtime),
    runtimeEvidence,
    runtime,
    service: Object.freeze({
      ...plan.service,
      description: `${SERVICE_RUNTIME_PREFIX} package=${packageIdentity} node=${nodeIdentity}`,
    }),
  });
}

export { PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL };
