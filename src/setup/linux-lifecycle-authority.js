import path from 'node:path';
import {
  environmentLifecycleAuthorityEndpoint,
  environmentLifecycleAuthorityIdentity,
} from '../runtime/environment-lifecycle-authority-transport.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-plan-v1';
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const SERVICE_PREFIX = 'devbridge-lifecycle-authority-';
const ACCOUNT_PREFIX = 'db-auth-';
const READ_GROUP_PREFIX = 'db-read-';
const COORD_GROUP_PREFIX = 'db-coord-';

function absoluteLinuxPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value) || !path.posix.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute Linux path`);
  }
  return path.posix.resolve(value);
}

function localName(value, name) {
  if (typeof value !== 'string' || !LOCAL_NAME.test(value)) throw new TypeError(`${name} must be a bounded local account or group name`);
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

function systemdUnit({ description, user, readGroup, coordinationGroup, providerGroup, nodeExecutable, serviceEntry, stateDirectory, authorityDirectory, runRoot, coordinationDirectory }) {
  const execStart = [
    nodeExecutable,
    serviceEntry,
    '--state-directory', stateDirectory,
    '--authority-directory', authorityDirectory,
  ].map(systemdQuote).join(' ');
  return [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Service]',
    'Type=simple',
    `User=${user}`,
    `Group=${readGroup}`,
    `SupplementaryGroups=${coordinationGroup} ${providerGroup}`,
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
    `ReadWritePaths=${systemdQuote(authorityDirectory)} ${systemdQuote(coordinationDirectory)} ${systemdQuote(runRoot)}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export function createLinuxLifecycleAuthorityPlan({
  stateDirectory,
  operatorName,
  providerGroup,
  varLibDirectory = '/var/lib/devbridge',
  runDirectory = '/run/devbridge',
  systemdDirectory = '/etc/systemd/system',
} = {}) {
  const state = absoluteLinuxPath(stateDirectory, 'Linux lifecycle authority stateDirectory');
  const operator = localName(operatorName, 'Linux lifecycle authority operatorName');
  const provider = localName(providerGroup, 'Linux lifecycle authority providerGroup');
  const varLib = absoluteLinuxPath(varLibDirectory, 'Linux lifecycle authority varLibDirectory');
  const run = absoluteLinuxPath(runDirectory, 'Linux lifecycle authority runDirectory');
  const systemd = absoluteLinuxPath(systemdDirectory, 'Linux lifecycle authority systemdDirectory');
  const authorityIdentity = environmentLifecycleAuthorityIdentity(state, { platform: 'linux' });
  const suffix = authorityIdentity.slice(0, 12);
  const serviceUser = `${ACCOUNT_PREFIX}${suffix}`;
  const readGroup = `${READ_GROUP_PREFIX}${suffix}`;
  const coordinationGroup = `${COORD_GROUP_PREFIX}${suffix}`;
  const serviceName = `${SERVICE_PREFIX}${suffix}.service`;
  const protectedRoot = under(varLib, 'lifecycle-authority', authorityIdentity);
  const authorityDirectory = under(protectedRoot, 'state');
  const binDirectory = under(protectedRoot, 'bin');
  const runtimeDirectory = under(protectedRoot, 'runtime');
  const packageDirectory = under(runtimeDirectory, 'package');
  const nodeExecutable = under(binDirectory, 'node');
  const serviceEntry = under(packageDirectory, 'src', 'entry', 'linux-lifecycle-authority-service.mjs');
  const packageManifest = under(packageDirectory, 'package.json');
  const ownershipManifest = under(protectedRoot, 'ownership.json');
  const runRoot = under(run, authorityIdentity);
  const readDirectory = under(runRoot, 'read');
  const mutationDirectory = under(runRoot, 'mutation');
  const coordinationDirectory = under(state, 'environment-foundation');
  const unitPath = under(systemd, serviceName);
  const readEndpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'read', platform: 'linux', runDirectory: run });
  const mutationEndpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'mutation', platform: 'linux', runDirectory: run });
  const description = `DevBridge Environment Lifecycle Authority ${suffix}`;
  const unit = systemdUnit({
    description,
    user: serviceUser,
    readGroup,
    coordinationGroup,
    providerGroup: provider,
    nodeExecutable,
    serviceEntry,
    stateDirectory: state,
    authorityDirectory,
    runRoot,
    coordinationDirectory,
  });

  return Object.freeze({
    protocol: PROTOCOL,
    authorityIdentity,
    stateDirectory: state,
    protectedRoot,
    authorityDirectory,
    ownershipManifest,
    service: Object.freeze({
      name: serviceName,
      unitPath,
      description,
      user: serviceUser,
      readGroup,
      coordinationGroup,
      providerGroup: provider,
      operator,
      account: Object.freeze({ home: '/nonexistent', shell: '/usr/sbin/nologin', system: true }),
      unit,
      restart: 'on-failure',
    }),
    runtime: Object.freeze({
      binDirectory,
      runtimeDirectory,
      packageDirectory,
      packageManifest,
      nodeExecutable,
      serviceEntry,
    }),
    coordination: Object.freeze({
      directory: coordinationDirectory,
      group: coordinationGroup,
      serviceWrite: true,
    }),
    endpoints: Object.freeze({
      runRoot,
      read: Object.freeze({ endpoint: readEndpoint, directory: readDirectory, owner: serviceUser, group: readGroup, mode: 0o770 }),
      mutation: Object.freeze({ endpoint: mutationEndpoint, directory: mutationDirectory, owner: serviceUser, group: 'root', mode: 0o700 }),
    }),
    access: Object.freeze({
      protectedRoot: Object.freeze({ owner: 'root', group: 'root', mode: 0o755, serviceWrite: false, ordinaryUserWrite: false }),
      protectedRuntime: Object.freeze({ owner: 'root', group: 'root', directoryMode: 0o755, fileMode: 0o444, executableMode: 0o555, serviceWrite: false, ordinaryUserWrite: false }),
      authorityState: Object.freeze({ owner: serviceUser, group: 'root', mode: 0o700, serviceWrite: true, ordinaryUserWrite: false }),
      ownershipManifest: Object.freeze({ owner: 'root', group: 'root', mode: 0o444, serviceWrite: false, ordinaryUserWrite: false }),
      readCapability: Object.freeze({ group: readGroup, members: Object.freeze([serviceUser, operator]) }),
      coordination: Object.freeze({ group: coordinationGroup, members: Object.freeze([serviceUser, operator]) }),
      providerManagement: Object.freeze({ group: provider, members: Object.freeze([serviceUser]), ordinaryUserMember: false }),
    }),
  });
}

export { PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL };
