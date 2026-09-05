import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createProtectedEnvironmentActivity } from '../app/environment-activity-host.js';
import { createEnvironmentLifecycleAuthorityHost } from '../app/environment-lifecycle-authority-host.js';
import { createEnvironmentLifecycleFence } from '../app/environment-lifecycle-fence.js';
import { createLocalEnvironmentOperator } from '../app/environment-operator-runtime.js';
import { createLinuxActivityAdmission } from '../app/linux-activity-admission.js';
import { createLinuxProtectedEnvironmentActivityState } from '../app/linux-environment-activity-state.js';
import { createLinuxProtectedEnvironmentConfiguration } from '../app/linux-environment-configuration-host.js';
import {
  environmentActivityAuthorityEndpoint,
  environmentActivityAuthorityIdentity,
} from '../runtime/environment-activity-authority-transport.js';
import {
  environmentConfigurationAuthorityEndpoint,
  environmentConfigurationAuthorityIdentity,
} from '../runtime/environment-configuration-authority-transport.js';
import {
  environmentLifecycleAuthorityEndpoint,
  environmentLifecycleAuthorityIdentity,
} from '../runtime/environment-lifecycle-authority-transport.js';
import { prepareLinuxLocalSocket } from '../setup/linux-local-socket-preparation.js';

const ARGUMENTS = new Set(['--state-directory', '--authority-directory', '--run-directory']);

function absoluteLinuxPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value) || !path.posix.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute Linux path`);
  }
  return path.posix.resolve(value);
}

function localIdentity(value) {
  if (!value || !Number.isSafeInteger(value.userId) || value.userId < 1
      || !Number.isSafeInteger(value.primaryGroupId) || value.primaryGroupId < 1
      || !Array.isArray(value.groupIds) || value.groupIds.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw new TypeError('Linux lifecycle authority service local identity is invalid');
  }
  const groups = [...new Set([...value.groupIds, value.primaryGroupId])];
  return Object.freeze({ userId: value.userId, primaryGroupId: value.primaryGroupId, groupIds: Object.freeze(groups) });
}

function processIdentity() {
  return localIdentity({
    userId: process.getuid?.(),
    primaryGroupId: process.getgid?.(),
    groupIds: process.getgroups?.(),
  });
}

async function prepareEndpoints(options, identity, prepare) {
  const lifecycleIdentity = environmentLifecycleAuthorityIdentity(options.stateDirectory, { platform: 'linux' });
  const configurationIdentity = environmentConfigurationAuthorityIdentity(options.stateDirectory, { platform: 'linux' });
  const activityIdentity = environmentActivityAuthorityIdentity(options.stateDirectory, { platform: 'linux' });
  const common = Object.freeze({
    directoryOwnerId: identity.userId,
    socketOwnerId: identity.userId,
    socketGroupId: identity.primaryGroupId,
    socketMode: 0o770,
  });
  const requests = [
    {
      ...common,
      endpoint: environmentLifecycleAuthorityEndpoint({ authorityIdentity: lifecycleIdentity, access: 'read', platform: 'linux', runDirectory: options.runDirectory }),
      directoryGroupIds: [identity.primaryGroupId],
      directoryMode: 0o750,
    },
    {
      ...common,
      endpoint: environmentLifecycleAuthorityEndpoint({ authorityIdentity: lifecycleIdentity, access: 'mutation', platform: 'linux', runDirectory: options.runDirectory }),
      directoryGroupIds: [0],
      directoryMode: 0o700,
    },
    {
      ...common,
      endpoint: environmentConfigurationAuthorityEndpoint({ authorityIdentity: configurationIdentity, platform: 'linux', runDirectory: options.runDirectory }),
      directoryGroupIds: identity.groupIds,
      directoryMode: 0o2750,
      socketGroupId: null,
    },
    {
      ...common,
      endpoint: environmentActivityAuthorityEndpoint({ authorityIdentity: activityIdentity, platform: 'linux', runDirectory: options.runDirectory }),
      directoryGroupIds: [identity.primaryGroupId],
      directoryMode: 0o2750,
    },
  ];
  for (const request of requests) {
    const result = await prepare(request);
    if (result?.ready !== true || result.endpoint !== request.endpoint || typeof result.changed !== 'boolean') {
      throw new Error('Linux lifecycle authority endpoint preparation evidence is invalid');
    }
  }
}

export function parseLinuxLifecycleAuthorityServiceArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError('Linux lifecycle authority service arguments must be an array');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!ARGUMENTS.has(flag) || typeof value !== 'string' || values.has(flag)) {
      throw new TypeError('Linux lifecycle authority service arguments are invalid');
    }
    values.set(flag, value);
  }
  if (values.size !== ARGUMENTS.size) throw new TypeError('Linux lifecycle authority service arguments are incomplete');
  return Object.freeze({
    stateDirectory: absoluteLinuxPath(values.get('--state-directory'), 'Linux lifecycle authority service stateDirectory'),
    authorityDirectory: absoluteLinuxPath(values.get('--authority-directory'), 'Linux lifecycle authority service authorityDirectory'),
    runDirectory: absoluteLinuxPath(values.get('--run-directory'), 'Linux lifecycle authority service runDirectory'),
  });
}

export async function runLinuxLifecycleAuthorityService({
  argv = process.argv.slice(2),
  hostFactory = createEnvironmentLifecycleAuthorityHost,
  admissionFactory = createLinuxActivityAdmission,
  fenceFactory = createEnvironmentLifecycleFence,
  configurationFactory = createLinuxProtectedEnvironmentConfiguration,
  routeStateFactory = createLinuxProtectedEnvironmentActivityState,
  operatorFactory = createLocalEnvironmentOperator,
  activityFactory = createProtectedEnvironmentActivity,
  socketPreparation = prepareLinuxLocalSocket,
  identityFactory = processIdentity,
  signalTarget = process,
} = {}) {
  if (typeof hostFactory !== 'function' || typeof admissionFactory !== 'function' || typeof fenceFactory !== 'function'
      || typeof configurationFactory !== 'function' || typeof routeStateFactory !== 'function'
      || typeof operatorFactory !== 'function' || typeof activityFactory !== 'function'
      || typeof socketPreparation !== 'function' || typeof identityFactory !== 'function') {
    throw new TypeError('Linux lifecycle authority service composition is invalid');
  }
  if (!signalTarget || typeof signalTarget.once !== 'function' || typeof signalTarget.off !== 'function') {
    throw new TypeError('Linux lifecycle authority service signalTarget is invalid');
  }
  const options = parseLinuxLifecycleAuthorityServiceArguments(argv);
  const identity = localIdentity(identityFactory());
  const routeState = routeStateFactory({
    stateDirectory: options.stateDirectory,
    authorityDirectory: options.authorityDirectory,
    platform: 'linux',
    runDirectory: options.runDirectory,
    serviceUserId: identity.userId,
  });
  if (!routeState || typeof routeState.load !== 'function' || typeof routeState.publish !== 'function' || typeof routeState.reconcile !== 'function') {
    throw new TypeError('Linux lifecycle authority service route-state contract is invalid');
  }
  const routeEvidence = await routeState.reconcile();
  if (routeEvidence?.ready !== true || typeof routeEvidence.changed !== 'boolean') {
    throw new Error('Linux lifecycle authority service route-state reconciliation is incomplete');
  }
  const configuration = configurationFactory({
    stateDirectory: options.stateDirectory,
    authorityDirectory: options.authorityDirectory,
    platform: 'linux',
    runDirectory: options.runDirectory,
  });
  const admission = await admissionFactory({
    access: 'exclusive',
    stateDirectory: options.stateDirectory,
    authorityDirectory: options.authorityDirectory,
    platform: 'linux',
    runDirectory: options.runDirectory,
  });
  const fence = fenceFactory({ admission });
  const operator = await operatorFactory({
    stateDirectory: options.stateDirectory,
    authorityDirectory: options.authorityDirectory,
    platform: 'linux',
    fence,
    routeState,
  });
  const activity = await activityFactory({
    stateDirectory: options.stateDirectory,
    authorityDirectory: options.authorityDirectory,
    platform: 'linux',
    policyLoader: () => routeState.load(),
  });
  await prepareEndpoints(options, identity, socketPreparation);
  const host = await hostFactory({
    stateDirectory: options.stateDirectory,
    authorityDirectory: options.authorityDirectory,
    platform: 'linux',
    runDirectory: options.runDirectory,
    operator,
    configuration,
    activity,
  });
  if (!host || typeof host.start !== 'function' || typeof host.close !== 'function') {
    throw new TypeError('Linux lifecycle authority service host contract is invalid');
  }
  await host.start();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    signalTarget.off('SIGTERM', onSignal);
    signalTarget.off('SIGINT', onSignal);
    await host.close();
  };
  const onSignal = () => {
    close().catch(() => {
      if ('exitCode' in signalTarget) signalTarget.exitCode = 1;
    });
  };
  signalTarget.once('SIGTERM', onSignal);
  signalTarget.once('SIGINT', onSignal);

  return Object.freeze({ authorityIdentity: host.authorityIdentity ?? null, close });
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  runLinuxLifecycleAuthorityService().catch(() => {
    process.exitCode = 1;
  });
}
