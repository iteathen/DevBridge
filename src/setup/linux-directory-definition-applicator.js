import path from 'node:path';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/linux-directory-definition-applicator-v1';
const EXECUTABLE = '/usr/bin/systemd-tmpfiles';
const DEFINITION_DIRECTORY = '/etc/tmpfiles.d';
const DEFINITION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}\.conf$/u;
const ENVIRONMENT = Object.freeze({ LANG: 'C', LC_ALL: 'C' });

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function definitionPath(value) {
  if (typeof value !== 'string' || value.length > 4_096 || /[\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value
      || path.posix.dirname(value) !== DEFINITION_DIRECTORY || !DEFINITION_NAME.test(path.posix.basename(value))) {
    throw new TypeError('Linux directory definition path is invalid');
  }
  return value;
}

function cancellationSignal(value) {
  const signal = value ?? null;
  if (signal != null && (typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError('Linux directory definition cancellation signal is invalid');
  }
  return signal;
}

function succeeded(value) {
  return value?.exitCode === 0
    && value?.timedOut !== true
    && value?.aborted !== true
    && value?.outputTruncated !== true;
}

export async function applyLinuxDirectoryDefinition(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['path', 'platform', 'signal']), 'Linux directory definition request');
  const platform = value.platform ?? process.platform;
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('Linux directory definition platform is invalid');
  if (platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform, applicable: false });
  const selectedPath = definitionPath(value.path);
  const signal = cancellationSignal(value.signal);
  exactKeys(providedPorts, new Set(['invoke']), 'Linux directory definition ports');
  const invoke = providedPorts.invoke ?? invokeCommand;
  if (typeof invoke !== 'function') throw new TypeError('Linux directory definition invocation port is invalid');

  let result;
  try {
    result = await invoke({
      executable: EXECUTABLE,
      arguments: ['--create', selectedPath],
      input: null,
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024,
      environment: ENVIRONMENT,
      signal,
    });
  } catch {
    throw new Error('Linux directory definition application failed');
  }
  if (!succeeded(result)) throw new Error('Linux directory definition application failed');
  return true;
}

export { PROTOCOL as LINUX_DIRECTORY_DEFINITION_APPLICATOR_PROTOCOL };
