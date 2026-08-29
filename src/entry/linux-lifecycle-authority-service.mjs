import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createEnvironmentLifecycleAuthorityHost } from '../app/environment-lifecycle-authority-host.js';
import { createEnvironmentLifecycleFence } from '../app/environment-lifecycle-fence.js';
import { createLinuxActivityAdmission } from '../app/linux-activity-admission.js';
import { createLinuxProtectedEnvironmentConfiguration } from '../app/linux-environment-configuration-host.js';

const ARGUMENTS = new Set(['--state-directory', '--authority-directory', '--run-directory']);

function absoluteLinuxPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value) || !path.posix.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute Linux path`);
  }
  return path.posix.resolve(value);
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
  signalTarget = process,
} = {}) {
  if (typeof hostFactory !== 'function' || typeof admissionFactory !== 'function' || typeof fenceFactory !== 'function'
      || typeof configurationFactory !== 'function') {
    throw new TypeError('Linux lifecycle authority service composition is invalid');
  }
  if (!signalTarget || typeof signalTarget.once !== 'function' || typeof signalTarget.off !== 'function') {
    throw new TypeError('Linux lifecycle authority service signalTarget is invalid');
  }
  const options = parseLinuxLifecycleAuthorityServiceArguments(argv);
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
  const host = await hostFactory({
    stateDirectory: options.stateDirectory,
    authorityDirectory: options.authorityDirectory,
    platform: 'linux',
    runDirectory: options.runDirectory,
    fence,
    configuration,
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
