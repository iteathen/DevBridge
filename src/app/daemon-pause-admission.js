import path from 'node:path';
import { pauseDaemon, resumeDaemon } from '../runtime/daemon-lock.js';

const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;

function bounded(value, name) {
  if (typeof value !== 'string' || !SAFE_VALUE.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

export function createDaemonPauseAdmission({
  stateDirectory,
  pause = pauseDaemon,
  resume = resumeDaemon,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('daemon pause admission stateDirectory is required');
  if (typeof pause !== 'function' || typeof resume !== 'function') throw new TypeError('daemon pause admission governance contract is incomplete');
  const lockPath = path.join(path.resolve(stateDirectory), 'daemon.lock');

  return Object.freeze({
    async acquire({ subject, operationId } = {}) {
      const selectedSubject = bounded(subject, 'daemon pause admission subject');
      bounded(operationId, 'daemon pause admission operationId');
      const status = await pause(lockPath);
      if (status?.activeLock === true && status.paused !== true) {
        throw new Error('daemon pause admission could not reach the safe boundary');
      }
      const ownsPause = status?.activeLock === true
        && status.requested === true
        && status.alreadyRequested !== true;
      let released = false;
      return Object.freeze({
        subject: selectedSubject,
        async release() {
          if (released) return;
          released = true;
          if (!ownsPause) return;
          const result = await resume(lockPath);
          if (result?.resumed !== true) throw new Error('daemon pause admission could not resume activity');
        },
      });
    },
  });
}
