import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/linux-service-manager-v1';
const SYSTEMCTL = '/usr/bin/systemctl';
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,126}\.service$/u;
const ENVIRONMENT = Object.freeze({ LANG: 'C', LC_ALL: 'C' });
const COMMON_ARGUMENTS = Object.freeze(['--system', '--no-pager', '--no-ask-password']);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function unitName(value) {
  if (typeof value !== 'string' || !UNIT.test(value)) throw new TypeError('Linux service manager unit is invalid');
  return value;
}

function invocationSucceeded(value) {
  return value?.exitCode === 0
    && value?.timedOut !== true
    && value?.aborted !== true
    && value?.outputTruncated !== true;
}

async function run(invoke, signal, argumentsList, name) {
  let result;
  try {
    result = await invoke({
      executable: SYSTEMCTL,
      arguments: [...COMMON_ARGUMENTS, ...argumentsList],
      input: null,
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024,
      environment: ENVIRONMENT,
      signal,
    });
  } catch {
    throw new Error(`Linux service manager ${name} failed`);
  }
  if (!invocationSucceeded(result)) throw new Error(`Linux service manager ${name} failed`);
  return true;
}

export function createLinuxServiceManager(value = {}) {
  exactKeys(value, new Set(['unit', 'platform', 'invoke', 'signal']), 'Linux service manager request');
  const platform = value.platform ?? process.platform;
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('Linux service manager platform is invalid');
  if (platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform, applicable: false });
  const unit = unitName(value.unit);
  const invoke = value.invoke ?? invokeCommand;
  if (typeof invoke !== 'function') throw new TypeError('Linux service manager invocation port is invalid');
  const signal = value.signal ?? null;
  if (signal != null && (typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError('Linux service manager cancellation signal is invalid');
  }

  return Object.freeze({
    protocol: PROTOCOL,
    platform: 'linux',
    applicable: true,
    refresh: () => run(invoke, signal, ['daemon-reload'], 'definition refresh'),
    persist: () => run(invoke, signal, ['enable', unit], 'persistence establishment'),
    quiesce: () => run(invoke, signal, ['stop', unit], 'quiesce'),
    activate: () => run(invoke, signal, ['start', unit], 'activation'),
  });
}

export { PROTOCOL as LINUX_SERVICE_MANAGER_PROTOCOL };
