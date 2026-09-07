import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  environmentLifecycleAuthorityEndpoint,
  environmentLifecycleAuthorityIdentity,
} from '../runtime/environment-lifecycle-authority-transport.js';
import {
  environmentConfigurationAuthorityEndpoint,
  environmentConfigurationAuthorityIdentity,
} from '../runtime/environment-configuration-authority-transport.js';
import {
  environmentActivityAuthorityEndpoint,
  environmentActivityAuthorityIdentity,
} from '../runtime/environment-activity-authority-transport.js';
import { linuxEnvironmentActivityHandoffTopology } from './linux-environment-activity-handoff.js';
import { linuxEnvironmentConfigurationHandoffTopology } from './linux-environment-configuration-handoff.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-plan-v2';
const DIGEST = /^[0-9a-f]{64}$/u;
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const MAX_LOCAL_ID = 0xffff_fffe;
const SERVICE_PREFIX = 'devbridge-lifecycle-authority-';
const ACCOUNT_PREFIX = 'db-auth-';
const READ_GROUP_PREFIX = 'db-read-';
const COORDINATION_GROUP_PREFIX = 'db-coord-';
const RUNTIME_GENERATION_DOMAIN = 'devbridge/linux-lifecycle-authority-runtime-generation-v1';
const VOLATILE_DEFINITION_DIRECTORY = '/etc/tmpfiles.d';

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

function groupIdentity(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  const allowed = new Set(['name', 'id']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  if (!Number.isSafeInteger(value.id) || value.id < 1 || value.id > MAX_LOCAL_ID) throw new TypeError(`${name} id is invalid`);
  return Object.freeze({ name: localName(value.name, `${name} name`), id: value.id });
}

function definitionPath(value, name) {
  if (typeof value !== 'string' || path.posix.resolve(value) !== value) {
    throw new TypeError(`${name} contains unsupported definition syntax`);
  }
  const selected = absoluteLinuxPath(value, name);
  if (selected === '/run' || !selected.startsWith('/run/') || /[\\%\s]/u.test(selected)) {
    throw new TypeError(`${name} contains unsupported definition syntax`);
  }
  return selected;
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
    '--run-directory', plan.endpoints.parentDirectory,
  ].map(systemdQuote).join(' ');
  const writable = [
    plan.authorityDirectory,
    plan.coordination.directory,
    plan.endpoints.read.directory,
    plan.endpoints.mutation.directory,
    plan.configuration.endpoint.directory,
    plan.activity.endpoint.directory,
    plan.activity.handoff.directory,
  ].map(systemdQuote).join(' ');
  return [
    '[Unit]',
    `Description=${plan.service.description}`,
    '',
    '[Service]',
    'Type=exec',
    `User=${plan.service.user}`,
    `Group=${plan.service.readGroup}`,
    `SupplementaryGroups=${plan.service.coordinationGroup} ${plan.service.managementGroupId}`,
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

function volatileDefinition(plan) {
  const lines = [
    [plan.endpoints.parentDirectory, '0755', 'root', 'root'],
    [plan.endpoints.runRoot, '0755', 'root', 'root'],
    [plan.coordination.directory, '3770', 'root', plan.coordination.group],
    [plan.endpoints.read.directory, '0750', plan.endpoints.read.directoryOwner, plan.endpoints.read.directoryGroup],
    [plan.endpoints.mutation.directory, '0700', plan.endpoints.mutation.directoryOwner, plan.endpoints.mutation.directoryGroup],
    [plan.configuration.root, '0755', 'root', 'root'],
    [plan.configuration.endpoint.directory, '2750', plan.configuration.endpoint.directoryOwner, plan.configuration.endpoint.directoryGroup],
    [plan.configuration.handoff.directory, '3770', plan.configuration.handoff.directoryOwner, plan.configuration.handoff.directoryGroup],
    [plan.activity.root, '0755', 'root', 'root'],
    [plan.activity.endpoint.directory, '2750', plan.activity.endpoint.directoryOwner, plan.activity.endpoint.directoryGroup],
    [plan.activity.handoff.directory, '3770', plan.activity.handoff.directoryOwner, plan.activity.handoff.directoryGroup],
  ];
  return `${lines.map(([target, mode, owner, group]) => `d ${target} ${mode} ${owner} ${group} -`).join('\n')}\n`
    + `f ${plan.coordination.lock.path} 0660 root ${plan.coordination.group} -\n`;
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
  const management = groupIdentity(managementGroup, 'Linux lifecycle authority managementGroup');
  const varLib = absoluteLinuxPath(varLibDirectory, 'Linux lifecycle authority varLibDirectory');
  const run = definitionPath(runDirectory, 'Linux lifecycle authority runDirectory');
  const systemd = absoluteLinuxPath(systemdDirectory, 'Linux lifecycle authority systemdDirectory');
  const authorityIdentity = environmentLifecycleAuthorityIdentity(state, { platform: 'linux' });
  const suffix = authorityIdentity.slice(0, 12);
  const serviceUser = `${ACCOUNT_PREFIX}${suffix}`;
  const readGroup = `${READ_GROUP_PREFIX}${suffix}`;
  const coordinationGroup = `${COORDINATION_GROUP_PREFIX}${suffix}`;
  const serviceName = `${SERVICE_PREFIX}${suffix}.service`;
  const definitionName = `${SERVICE_PREFIX}${suffix}.conf`;
  const storageRoot = under(varLib, 'lifecycle-authority');
  const protectedRoot = under(storageRoot, authorityIdentity);
  const authorityDirectory = under(protectedRoot, 'state');
  const ownershipManifest = under(protectedRoot, 'ownership.json');
  const refreshJournal = under(protectedRoot, 'refresh.json');
  const generationsDirectory = under(protectedRoot, 'generations');
  const stagingDirectory = under(protectedRoot, 'staging');
  const runRoot = under(run, authorityIdentity);
  const readDirectory = under(runRoot, 'read');
  const mutationDirectory = under(runRoot, 'mutation');
  const coordinationDirectory = under(runRoot, 'governance');
  const coordinationLock = under(coordinationDirectory, 'activity.lock');
  const sharedIntent = under(coordinationDirectory, 'shared.intent');
  const exclusiveIntent = under(coordinationDirectory, 'exclusive.intent');
  const unitPath = under(systemd, serviceName);
  const readEndpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'read', platform: 'linux', runDirectory: run });
  const mutationEndpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'mutation', platform: 'linux', runDirectory: run });
  const configurationIdentity = environmentConfigurationAuthorityIdentity(state, { platform: 'linux' });
  const configurationTopology = linuxEnvironmentConfigurationHandoffTopology({ stateDirectory: state, runDirectory: run });
  if (configurationTopology.identity !== configurationIdentity) throw new Error('Linux configuration authority identity is inconsistent');
  const configurationEndpoint = environmentConfigurationAuthorityEndpoint({
    authorityIdentity: configurationIdentity,
    platform: 'linux',
    runDirectory: run,
  });
  const activityIdentity = environmentActivityAuthorityIdentity(state, { platform: 'linux' });
  const activityTopology = linuxEnvironmentActivityHandoffTopology({
    stateDirectory: state,
    authorityDirectory,
    runDirectory: run,
  });
  if (activityTopology.identity !== activityIdentity) throw new Error('Linux activity authority identity is inconsistent');
  const activityEndpoint = environmentActivityAuthorityEndpoint({
    authorityIdentity: activityIdentity,
    platform: 'linux',
    runDirectory: run,
  });
  const coordination = Object.freeze({
    directory: coordinationDirectory,
    group: coordinationGroup,
    directoryOwner: 'root',
    directoryMode: 0o3770,
    lock: Object.freeze({ path: coordinationLock, owner: 'root', group: coordinationGroup, mode: 0o660 }),
    shared: Object.freeze({ path: sharedIntent, owner: operator, group: coordinationGroup, mode: 0o640 }),
    exclusive: Object.freeze({ path: exclusiveIntent, owner: serviceUser, group: coordinationGroup, mode: 0o640 }),
    serviceWrite: true,
  });

  const endpoints = {
    parentDirectory: run,
    runRoot,
    definition: Object.freeze({
      name: definitionName,
      path: under(VOLATILE_DEFINITION_DIRECTORY, definitionName),
      content: null,
    }),
    read: Object.freeze({
      endpoint: readEndpoint,
      directory: readDirectory,
      directoryOwner: serviceUser,
      directoryGroup: readGroup,
      directoryMode: 0o750,
      socketOwner: serviceUser,
      socketGroup: readGroup,
      socketMode: 0o770,
    }),
    mutation: Object.freeze({
      endpoint: mutationEndpoint,
      directory: mutationDirectory,
      directoryOwner: serviceUser,
      directoryGroup: 'root',
      directoryMode: 0o700,
      socketOwner: serviceUser,
      socketGroup: readGroup,
      socketMode: 0o770,
    }),
  };
  const configuration = Object.freeze({
    authorityIdentity: configurationIdentity,
    root: configurationTopology.root,
    endpoint: Object.freeze({
      endpoint: configurationEndpoint,
      directory: configurationTopology.endpointDirectory,
      directoryOwner: serviceUser,
      directoryGroup: coordinationGroup,
      directoryMode: 0o2750,
      socketOwner: serviceUser,
      socketGroup: coordinationGroup,
      socketMode: 0o770,
    }),
    handoff: Object.freeze({
      directory: configurationTopology.handoffDirectory,
      record: configurationTopology.record,
      directoryOwner: 'root',
      directoryGroup: coordinationGroup,
      directoryMode: 0o3770,
      recordOwner: operator,
      recordGroup: coordinationGroup,
      recordMode: 0o640,
    }),
  });
  const activity = Object.freeze({
    authorityIdentity: activityIdentity,
    root: activityTopology.root,
    endpoint: Object.freeze({
      endpoint: activityEndpoint,
      directory: activityTopology.endpointDirectory,
      directoryOwner: serviceUser,
      directoryGroup: readGroup,
      directoryMode: 0o2750,
      socketOwner: serviceUser,
      socketGroup: readGroup,
      socketMode: 0o770,
    }),
    handoff: Object.freeze({
      directory: activityTopology.handoffDirectory,
      record: activityTopology.record,
      source: activityTopology.source,
      directoryOwner: 'root',
      directoryGroup: readGroup,
      directoryMode: 0o3770,
      recordOwner: serviceUser,
      recordGroup: readGroup,
      recordMode: 0o640,
    }),
  });
  endpoints.definition = Object.freeze({ ...endpoints.definition, content: volatileDefinition({ endpoints, coordination, configuration, activity }) });

  return Object.freeze({
    protocol: PROTOCOL,
    authorityIdentity,
    stateDirectory: state,
    storage: Object.freeze({ parentDirectory: varLib, rootDirectory: storageRoot }),
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
      managementGroup: management.name,
      managementGroupId: management.id,
      operator,
      account: Object.freeze({ home: '/nonexistent', shell: '/usr/sbin/nologin', system: true }),
      restart: 'on-failure',
    }),
    coordination,
    configuration,
    activity,
    endpoints: Object.freeze(endpoints),
    access: Object.freeze({
      storageRoot: Object.freeze({ owner: 'root', group: 'root', mode: 0o755, serviceWrite: false, ordinaryUserWrite: false }),
      protectedRoot: Object.freeze({ owner: 'root', group: 'root', mode: 0o755, serviceWrite: false, ordinaryUserWrite: false }),
      protectedRuntime: Object.freeze({ owner: 'root', group: 'root', directoryMode: 0o755, fileMode: 0o444, executableMode: 0o555, serviceWrite: false, ordinaryUserWrite: false }),
      authorityState: Object.freeze({ owner: serviceUser, group: 'root', mode: 0o700, serviceWrite: true, ordinaryUserWrite: false }),
      ownershipManifest: Object.freeze({ owner: 'root', group: 'root', mode: 0o444, serviceWrite: false, ordinaryUserWrite: false }),
      refreshJournal: Object.freeze({ owner: 'root', group: 'root', mode: 0o600, serviceWrite: false, ordinaryUserWrite: false }),
      volatileDefinition: Object.freeze({ owner: 'root', group: 'root', mode: 0o644, serviceWrite: false, ordinaryUserWrite: false }),
      readCapability: Object.freeze({ group: readGroup, members: Object.freeze([serviceUser, operator]) }),
      coordination: Object.freeze({ group: coordinationGroup, members: Object.freeze([serviceUser, operator]) }),
      management: Object.freeze({ group: management.name, groupId: management.id, members: Object.freeze([serviceUser]), ordinaryUserMember: false }),
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
