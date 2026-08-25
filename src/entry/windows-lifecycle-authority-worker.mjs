import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { createLocalEnvironmentOperator } from '../app/environment-operator-runtime.js';
import {
  createLifecycleAuthorityMutationHandler,
  createLifecycleAuthorityReadHandler,
  ENVIRONMENT_LIFECYCLE_AUTHORITY_MAX_ENVELOPE_BYTES,
} from '../runtime/environment-lifecycle-authority.js';

const MAX_WIRE_BYTES = ENVIRONMENT_LIFECYCLE_AUTHORITY_MAX_ENVELOPE_BYTES + 1024;
const ACCESS = new Set(['read', 'mutation']);
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

export async function handleWindowsLifecycleAuthorityWorkerRequest({ access, operator, request } = {}) {
  if (!ACCESS.has(access)) throw new TypeError('Windows lifecycle authority worker access class is invalid');
  const handler = access === 'read'
    ? createLifecycleAuthorityReadHandler({ operator })
    : createLifecycleAuthorityMutationHandler({ operator });
  return handler(request);
}

async function readSingleRequest(input) {
  let wire = Buffer.alloc(0);
  for await (const chunk of input) {
    wire = Buffer.concat([wire, Buffer.from(chunk)]);
    if (wire.length > MAX_WIRE_BYTES) throw new Error('Windows lifecycle authority worker request exceeded the transport bound');
  }
  const text = wire.toString('utf8');
  const newline = text.indexOf('\n');
  if (newline < 0 || text.slice(newline + 1).trim() !== '') throw new Error('Windows lifecycle authority worker request framing is invalid');
  return JSON.parse(text.slice(0, newline));
}

export async function runWindowsLifecycleAuthorityWorker({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout } = {}) {
  const options = parseWindowsLifecycleAuthorityWorkerArguments(argv);
  const request = await readSingleRequest(input);
  const operator = await createLocalEnvironmentOperator({
    stateDirectory: options.stateDirectory,
    authorityDirectory: options.authorityDirectory,
    platform: 'win32',
  });
  const response = await handleWindowsLifecycleAuthorityWorkerRequest({ access: options.access, operator, request });
  const wire = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(wire, 'utf8') > MAX_WIRE_BYTES) throw new Error('Windows lifecycle authority worker response exceeded the transport bound');
  output.write(wire);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  runWindowsLifecycleAuthorityWorker().catch(() => {
    process.exitCode = 1;
  });
}
