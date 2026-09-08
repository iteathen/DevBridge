import path from 'node:path';
import { createProcessFileLease } from './process-file-lease.js';

export function createWindowsFileLease({ subjectPath, holderExecutable } = {}, options = {}) {
  for (const value of [subjectPath, holderExecutable]) {
    if (typeof value !== 'string' || !/^[A-Za-z]:\\/u.test(value) || /[\0\r\n]/u.test(value) || path.win32.normalize(value) !== value) {
      throw new TypeError('Windows file lease requires normalized absolute local paths');
    }
  }
  return createProcessFileLease({
    readyLine: 'devbridge/file-lease-held-v1\n',
    commandFor(mode) {
      if (mode !== 'exclusive') throw new TypeError('Windows mutation lease requires exclusive mode');
      return { executable: holderExecutable, arguments: ['--hold-file-lease', subjectPath] };
    },
  }, options);
}
