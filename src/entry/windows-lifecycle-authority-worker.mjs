import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import {
  createLifecycleAuthorityMutationHandler,
  createLifecycleAuthorityReadHandler,
  ENVIRONMENT_LIFECYCLE_AUTHORITY_MAX_ENVELOPE_BYTES,
  ENVIRONMENT_LIFECYCLE_AUTHORITY_RESULT_PROTOCOL,
} from '../runtime/environment-lifecycle-authority.js';
import {
  createEnvironmentActivityHandler,
  ENVIRONMENT_ACTIVITY_AUTHORITY_MAX_REQUEST_BYTES,
  ENVIRONMENT_ACTIVITY_AUTHORITY_MAX_RESULT_BYTES,
  ENVIRONMENT_ACTIVITY_AUTHORITY_RESULT_PROTOCOL,
} from '../runtime/environment-activity-authority.js';
import {
  createEnvironmentConfigurationHandler,
  ENVIRONMENT_CONFIGURATION_AUTHORITY_MAX_REQUEST_BYTES,
  ENVIRONMENT_CONFIGURATION_AUTHORITY_MAX_RESULT_BYTES,
  ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL,
} from '../runtime/environment-configuration-authority.js';

const LIFECYCLE_MAX_WIRE_BYTES = ENVIRONMENT_LIFECYCLE_AUTHORITY_MAX_ENVELOPE_BYTES + 1024;
const ACTIVITY_MAX_REQUEST_WIRE_BYTES = ENVIRONMENT_ACTIVITY_AUTHORITY_MAX_REQUEST_BYTES + 1024;
const ACTIVITY_MAX_RESULT_WIRE_BYTES = ENVIRONMENT_ACTIVITY_AUTHORITY_MAX_RESULT_BYTES + 1024;
const CONFIGURATION_MAX_REQUEST_WIRE_BYTES = ENVIRONMENT_CONFIGURATION_AUTHORITY_MAX_REQUEST_BYTES + 1024;
const CONFIGURATION_MAX_RESULT_WIRE_BYTES = ENVIRONMENT_CONFIGURATION_AUTHORITY_MAX_RESULT_BYTES + 1024;
const ACCESS = new Set(['read', 'mutation', 'acceptance', 'activity', 'configuration']);
const ARGUMENTS = new Set(['--access', '--state-directory', '--authority-directory']);
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:\\$/u;
const WINDOWS_UNC_ROOT = /^\\\\[^\\]+\\[^\\]+\\$/u;

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

export function parseWindowsLifecycleAuthorityWorkerArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError('Windows lifecycle authority worker arguments must be an array');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!ARGUMENTS.has(flag) || typeof value !== 'string' || values.has(flag)) {
      throw new TypeError('Windows lifecycle authority worker arguments are invalid');
    }
    values.set(flag, value);
  }
  if (values.size !== ARGUMENTS.size) throw new TypeError('Windows lifecycle authority worker arguments are incomplete');
  const access = values.get('--access');
  if (!ACCESS.has(access)) throw new TypeError('Windows lifecycle authority worker access class is invalid');
  return Object.freeze({
    access,
    stateDirectory: absoluteWindowsPath(values.get('--state-directory'), 'Windows lifecycle authority worker stateDirectory'),
    authorityDirectory: absoluteWindowsPath(values.get('--authority-directory'), 'Windows lifecycle authority worker authorityDirectory'),
  });
}

function workerInitializationFailure(request, error, access) {
  const rawCode = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  const errorClass = /^[A-Z][A-Z0-9_]{0,63}$/u.test(rawCode)
    ? rawCode
    : ['Error', 'TypeError', 'SyntaxError', 'RangeError'].includes(error?.name)
      ? error.name
      : 'UNKNOWN';
  const requestId = typeof request?.requestId === 'string' && /^[0-9a-f-]{36}$/iu.test(request.requestId)
    ? request.requestId
    : '00000000-0000-4000-8000-000000000000';
  return Object.freeze({
    protocol: access === 'activity'
      ? ENVIRONMENT_ACTIVITY_AUTHORITY_RESULT_PROTOCOL
      : access === 'configuration'
        ? ENVIRONMENT_CONFIGURATION_AUTHORITY_RESULT_PROTOCOL
        : ENVIRONMENT_LIFECYCLE_AUTHORITY_RESULT_PROTOCOL,
    requestId,
    ok: false,
    error: Object.freeze({
      code: 'WORKER_INITIALIZATION_FAILED',
      message: `environment ${access === 'activity' ? 'activity' : access === 'configuration' ? 'configuration' : 'lifecycle'} authority worker initialization failed (${errorClass})`,
    }),
  });
}

export async function handleWindowsLifecycleAuthorityWorkerRequest({
  access,
  operator = null,
  activity = null,
  configuration = null,
  request,
  authorityDirectory = null,
} = {}, {
  acceptanceHandler = null,
} = {}) {
  if (!ACCESS.has(access)) throw new TypeError('Windows lifecycle authority worker access class is invalid');
  if (access === 'acceptance') {
    if (typeof acceptanceHandler !== 'function') throw new TypeError('Windows lifecycle authority acceptance handler is invalid');
    return acceptanceHandler({ request, authorityDirectory });
  }
  if (access === 'activity') return createEnvironmentActivityHandler({ activity })(request);
  if (access === 'configuration') return createEnvironmentConfigurationHandler({ configuration })(request);
  const handler = access === 'read'
    ? createLifecycleAuthorityReadHandler({ operator })
    : createLifecycleAuthorityMutationHandler({ operator });
  return handler(request);
}

async function readSingleRequest(input, maxWireBytes) {
  let wire = Buffer.alloc(0);
  for await (const chunk of input) {
    wire = Buffer.concat([wire, Buffer.from(chunk)]);
    if (wire.length > maxWireBytes) throw new Error('Windows lifecycle authority worker request exceeded the transport bound');
  }
  const text = wire.toString('utf8');
  const newline = text.indexOf('\n');
  if (newline < 0 || text.slice(newline + 1).trim() !== '') throw new Error('Windows lifecycle authority worker request framing is invalid');
  return JSON.parse(text.slice(0, newline));
}

export async function runWindowsLifecycleAuthorityWorker({
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  operatorFactory = null,
  activityFactory = null,
  configurationFactory = null,
  acceptanceHandler = null,
} = {}) {
  const options = parseWindowsLifecycleAuthorityWorkerArguments(argv);
  const requestLimit = options.access === 'activity'
    ? ACTIVITY_MAX_REQUEST_WIRE_BYTES
    : options.access === 'configuration'
      ? CONFIGURATION_MAX_REQUEST_WIRE_BYTES
      : LIFECYCLE_MAX_WIRE_BYTES;
  const request = await readSingleRequest(input, requestLimit);
  let response;
  try {
    if (options.access === 'acceptance') {
      const selectedAcceptanceHandler = acceptanceHandler ?? (await import('../setup/windows-lifecycle-authority-acceptance.js')).handleWindowsLifecycleAuthorityAcceptanceRequest;
      response = await handleWindowsLifecycleAuthorityWorkerRequest({
        access: options.access,
        request,
        authorityDirectory: options.authorityDirectory,
      }, { acceptanceHandler: selectedAcceptanceHandler });
    } else if (options.access === 'activity') {
      const selectedActivityFactory = activityFactory ?? (await import('../app/environment-activity-host.js')).createProtectedEnvironmentActivity;
      if (typeof selectedActivityFactory !== 'function') throw new TypeError('Windows environment activity factory is invalid');
      const activity = await selectedActivityFactory({
        stateDirectory: options.stateDirectory,
        authorityDirectory: options.authorityDirectory,
        platform: 'win32',
      });
      response = await handleWindowsLifecycleAuthorityWorkerRequest({ access: options.access, activity, request });
    } else if (options.access === 'configuration') {
      const selectedConfigurationFactory = configurationFactory ?? (await import('../app/windows-environment-configuration-host.js')).createWindowsProtectedEnvironmentConfiguration;
      if (typeof selectedConfigurationFactory !== 'function') throw new TypeError('Windows environment configuration factory is invalid');
      const configuration = await selectedConfigurationFactory({
        stateDirectory: options.stateDirectory,
        authorityDirectory: options.authorityDirectory,
        platform: 'win32',
      });
      response = await handleWindowsLifecycleAuthorityWorkerRequest({ access: options.access, configuration, request });
    } else {
      const selectedOperatorFactory = operatorFactory ?? (await import('../app/environment-operator-runtime.js')).createLocalEnvironmentOperator;
      if (typeof selectedOperatorFactory !== 'function') throw new TypeError('Windows lifecycle authority operator factory is invalid');
      const operator = await selectedOperatorFactory({
        stateDirectory: options.stateDirectory,
        authorityDirectory: options.authorityDirectory,
        platform: 'win32',
      });
      response = await handleWindowsLifecycleAuthorityWorkerRequest({ access: options.access, operator, request });
    }
  } catch (error) {
    response = workerInitializationFailure(request, error, options.access);
  }
  const wire = `${JSON.stringify(response)}\n`;
  const responseLimit = options.access === 'activity'
    ? ACTIVITY_MAX_RESULT_WIRE_BYTES
    : options.access === 'configuration'
      ? CONFIGURATION_MAX_RESULT_WIRE_BYTES
      : LIFECYCLE_MAX_WIRE_BYTES;
  if (Buffer.byteLength(wire, 'utf8') > responseLimit) throw new Error('Windows lifecycle authority worker response exceeded the transport bound');
  output.write(wire);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  runWindowsLifecycleAuthorityWorker().catch(() => {
    process.exitCode = 1;
  });
}
