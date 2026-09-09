import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activityLeaseHolderReadyLine } from './activity-lease-protocol.js';
import { createProcessFileLease } from './process-file-lease.js';

const EXECUTABLE = '/usr/bin/flock';
const HOLDER = fileURLToPath(new URL('../entry/activity-lease-holder.mjs', import.meta.url));
const CONFLICT_EXIT_CODE = 75;

function subjectPath(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)
    || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value || value === '/') {
    throw new TypeError('Linux file lease subject must be a normalized absolute path');
  }
  return value;
}

function argumentsFor(mode, target) {
  return Object.freeze([
    '--no-fork',
    mode === 'shared' ? '--shared' : '--exclusive',
    ...(mode === 'shared' ? ['--nonblock'] : ['--timeout', '30']),
    '--conflict-exit-code', String(CONFLICT_EXIT_CODE),
    '--', target, process.execPath, HOLDER,
  ]);
}

export function createLinuxFileLease(raw = {}, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Linux file lease configuration is invalid');
  if (Object.keys(raw).some((key) => key !== 'subjectPath')) throw new TypeError('Linux file lease configuration contains an unknown field');
  const target = subjectPath(raw.subjectPath);
  return createProcessFileLease({
    readyLine: activityLeaseHolderReadyLine(),
    commandFor: (mode) => ({ executable: EXECUTABLE, arguments: argumentsFor(mode, target) }),
  }, options);
}
