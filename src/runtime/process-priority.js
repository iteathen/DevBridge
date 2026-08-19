import os from 'node:os';
import { PolicyError } from '../errors.js';

export const PROCESS_PRIORITY_LEVELS = Object.freeze(['normal', 'below-normal', 'low']);

const PRIORITY_VALUES = Object.freeze({
  normal: os.constants.priority.PRIORITY_NORMAL,
  'below-normal': os.constants.priority.PRIORITY_BELOW_NORMAL,
  low: os.constants.priority.PRIORITY_LOW,
});

export function processPriorityValue(level) {
  if (!Object.hasOwn(PRIORITY_VALUES, level)) {
    throw new PolicyError(`unsupported child process priority: ${level}`);
  }
  return PRIORITY_VALUES[level];
}

async function waitForSpawn(child) {
  if (Number.isSafeInteger(child?.pid) && child.pid > 0) return child.pid;
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      if (Number.isSafeInteger(child?.pid) && child.pid > 0) resolve(child.pid);
      else reject(new PolicyError('spawned child did not expose a usable PID for priority governance'));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child?.removeListener?.('spawn', onSpawn);
      child?.removeListener?.('error', onError);
    };
    child?.once?.('spawn', onSpawn);
    child?.once?.('error', onError);
  });
}

export async function applyChildProcessPriority(child, level = 'normal', { setPriority = os.setPriority } = {}) {
  const value = processPriorityValue(level);
  if (level === 'normal') {
    return { level, value, applied: false, reason: 'normal-priority' };
  }
  const pid = await waitForSpawn(child);
  try {
    setPriority(pid, value);
  } catch (error) {
    throw new PolicyError(`failed to apply configured child process priority ${level}`, { cause: error });
  }
  return { level, value, applied: true };
}
