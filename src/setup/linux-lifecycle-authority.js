import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  environmentLifecycleAuthorityEndpoint,
  environmentLifecycleAuthorityIdentity,
} from '../runtime/environment-lifecycle-authority-transport.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-plan-v1';
const DIGEST = /^[0-9a-f]{64}$/u;
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const SERVICE_PREFIX = 'devbridge-lifecycle-authority-';
const ACCOUNT_PREFIX = 'db-auth-';
const READ_GROUP_PREFIX = 'db-read-';
const COORDINATION_GROUP_PREFIX = 'db-coord-';
const RUNTIME_GENERATION_DOMAIN = 'devbridge/linux-lifecycle-authority-runtime-generation-v1';

function absoluteLinuxPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value) || !path.posix.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute Linux path`);
  }
  return path.posix.resolve(value);
}

function localName(value, name) {
  if (typeof value !== 'string' || !LOCAL_NAME.test(value)) {
    throw new TypeError(`${name} must be a portable bounded local account or group name`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${name} must be a sha256 digest`);
  return value;
}

function under(root, ...segments) {
  const target = path.posix.resolve(root, ...segments);
  const relative = path.posix.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error('Linux lifecycle authority protected path escaped its root');
  }
  return target;
}

function systemdQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function runtimeLayout(plan, generation) {
  const identity = digest(generation, 'Linux lifecycle authority runtime generation');
  const generationDirectory = under(plan.runtime.generationsDirectory, identity);
  const binDirectory = under(generationDirectory, 'bin');
  const packageDirectory = under(generationDirectory, 'package');
  return Object.freeze({
    generationsDirectory: plan.runtime.generationsDirectory,
    stagingDirectory: plan.runtime.stagingDirectory,
    generation: identity,
    generationDirectory,
    binDirectory,
    packageDirectory,
    generationManifest: under(generationDirectory, 'generation.json'),
    nodeExecutable: under(binDirectory, 'node'),
    packageManifest: under(packageDirectory, 'package.json'),
    serviceEntry: under(packageDirectory, 'src', 'entry', 'linux-lifecycle-authority-service.mjs'),
  });
}

function systemdUnit(plan, runtime) {
  const execStart = [
    runtime.nodeExecutable,
    runtime.serviceEntry,
    '--state-directory', plan.stateDirectory,
    '--authority-directory', plan.authorityDirectory,
  ].map(systemdQuote).join(' ');
  const writable = [
    plan.authorityDirectory,
    plan.coordination.directory,
    plan.endpoints.read.directory,
    plan.endpoints.mutation.directory,
  ].map(systemdQuote).join(' ');
  return [
    '[Unit]',
    `Description=${plan.service.description}`,
    '',
    '[Service]',
    'Type=exec',
    `User=${plan.service.user}`,
    `Group=${plan.service.readGroup}`,
    `SupplementaryGroups=${plan.service.coordinationGroup} ${plan.service.managementGroup}`,
    'UMask=0007',
    `ExecStart=${execStart}`,
    'Restart=on-failure',
    'RestartSec=5s',
    'TimeoutStopSec=30s',
    'KillMode=mixed',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
    'CapabilityBoundingSet=',
    `ReadWritePaths=${writable}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export function linuxLifecycleAuthorityRuntimeGeneration({ packageDigest, nodeDigest } = {}) {
  const packageIdentity = digest(packageDigest, 'Linux lifecycle authority package digest');
  const nodeIdentity = digest(nodeDigest, 'Linux lifecycle authority Node digest');
  return createHash('sha256')
    .update(`${RUNTIME_GENERATION_DOMAIN}\0`, 'utf8')
    .update(packageIdentity, 'utf8')
    .update('\0', 'utf8')
    .update(nodeIdentity, 'utf8')
    .digest('hex');
}

export function createLinuxLifecycleAuthorityPlan({
  stateDirectory,
  operatorName,
  managementGroup,
  varLibDirectory = '/var/lib/devbridge',
  runDirectory = '/run/devbridge',
  systemdDirectory = '/etc/systemd/system',
} = {}) {
  const state = absoluteLinuxPath(stateDirectory, 'Linux lifecycle authority stateDirectory');
  const operator = localName(operatorName, 'Linux lifecycle authority operatorName');
  const management = localName(managementGroup, 'Linux lifecycle authority managementGroup');
  const varLib = absoluteLinuxPath(varLibDirectory, 'Linux lifecycle authority varLibDirectory');
  const run = absoluteLinuxPath(runDirectory, 'Linux lifecycle authority runDirectory');
  const systemd = absoluteLinuxPath(systemdDirectory, 'Linux lifecycle authority systemdDirectory');
  const authorityIdentity = environmentLifecycleAuthorityIdentity(state, { platform: 'linux' });
  const suffix = authorityIdentity.slice(0, 12);
  const serviceUser = `${ACCOUNT_PREFIX}${suffix}`;
  const readGroup = `${READ_GROUP_PREFIX}${suffix}`;
  const coordinationGroup = `${COORDINATION_GROUP_PREFIX}${suffix}`;
  const serviceName = `${SERVICE_PREFIX}${suffix}.service`;
  const protectedRoot = under(varLib, 'lifecycle-authority', authorityIdentity);
  const authorityDirectory = under(protectedRoot, 'state');
  const ownershipManifest = under(protectedRoot, 'ownership.json');
  const refreshJournal = under(protectedRoot, 'refresh.json');
  const generationsDirectory = under(protectedRoot, 'generations');
  const stagingDirectory = under(protectedRoot, 'staging');
  const runRoot = under(run, authorityIdentity);
  const readDirectory = under(runRoot, 'read');
  const mutationDirectory = under(runRoot, 'mutation');
  const coordinationDirectory = under(state, 'environment-foundation');
  const unitPath = under(systemd, serviceName);
  const readEndpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'read', platform: 'linux', runDirectory: run });
  const mutationEndpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'mutation', platform: 'linux', runDirectory: run });

  return Object.freeze({
    protocol: PROTOCOL,
    authorityIdentity,
    stateDirectory: state,
    protectedRoot,
    authorityDirectory,
    ownershipManifest,
    refreshJournal,
    runtimeEvidence: null,
    runtime: Object.freeze({ generationsDirectory, stagingDirectory }),
    service: Object.freeze({
      name: serviceName,
      unitPath,
      unit: null,
      description: `DevBridge Environment Lifecycle Authority ${suffix}`,
      user: serviceUser,
      readGroup,
      coordinationGroup,
      managementGroup: management,
      operator,
      account: Object.freeze({ home: '/nonexistent', shell: '/usr/sbin/nologin', system: true }),
      restart: 'on-failure',
    }),
    coordination: Object.freeze({
      directory: coordinationDirectory,
      group: coordinationGroup,
      serviceWrite: true,
    }),
    endpoints: Object.freeze({
      runRoot,
      read: Object.freeze({ endpoint: readEndpoint, directory: readDirectory, owner: serviceUser, group: readGroup, directoryMode: 0o750, socketMode: 0o770 }),
      mutation: Object.freeze({ endpoint: mutationEndpoint, directory: mutationDirectory, owner: serviceUser, group: 'root', directoryMode: 0o700, socketMode: 0o700 }),
    }),
    access: Object.freeze({
      protectedRoot: Object.freeze({ owner: 'root', group: 'root', mode: 0o755, serviceWrite: false, ordinaryUserWrite: false }),
      protectedRuntime: Object.freeze({ owner: 'root', group: 'root', directoryMode: 0o755, fileMode: 0o444, executableMode: 0o555, serviceWrite: false, ordinaryUserWrite: false }),
      authorityState: Object.freeze({ owner: serviceUser, group: 'root', mode: 0o700, serviceWrite: true, ordinaryUserWrite: false }),
      ownershipManifest: Object.freeze({ owner: 'root', group: 'root', mode: 0o444, serviceWrite: false, ordinaryUserWrite: false }),
      readCapability: Object.freeze({ group: readGroup, members: Object.freeze([serviceUser, operator]) }),
      coordination: Object.freeze({ group: coordinationGroup, members: Object.freeze([serviceUser, operator]) }),
      management: Object.freeze({ group: management, members: Object.freeze([serviceUser]), ordinaryUserMember: false }),
    }),
  });
}

export function bindLinuxLifecycleAuthorityRuntime(plan, { packageDigest, nodeDigest } = {}) {
  if (!plan || typeof plan !== 'object' || plan.protocol !== PROTOCOL) throw new TypeError('Linux lifecycle authority plan is required');
  if (plan.runtimeEvidence != null || plan.runtime?.generation != null || plan.service?.unit != null) {
    throw new Error('Linux lifecycle authority runtime evidence is already bound');
  }
  return projectLinuxLifecycleAuthorityRuntime(plan, { packageDigest, nodeDigest });
}

export function projectLinuxLifecycleAuthorityRuntime(plan, { packageDigest, nodeDigest } = {}) {
  if (!plan || typeof plan !== 'object' || plan.protocol !== PROTOCOL) throw new TypeError('Linux lifecycle authority plan is required');
  const packageIdentity = digest(packageDigest, 'Linux lifecycle authority package digest');
  const nodeIdentity = digest(nodeDigest, 'Linux lifecycle authority Node digest');
  const generation = linuxLifecycleAuthorityRuntimeGeneration({ packageDigest: packageIdentity, nodeDigest: nodeIdentity });
  const runtime = runtimeLayout(plan, generation);
  const runtimeEvidence = Object.freeze({ packageDigest: packageIdentity, nodeDigest: nodeIdentity });
  const service = Object.freeze({ ...plan.service, unit: null });
  const bound = { ...plan, runtimeEvidence, runtime, service };
  return Object.freeze({
    ...bound,
    service: Object.freeze({ ...service, unit: systemdUnit(bound, runtime) }),
  });
}

export { PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL };
