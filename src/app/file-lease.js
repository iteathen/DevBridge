import path from 'node:path';
import { createLinuxFileLease } from '../runtime/linux-file-lease.js';
import { createWindowsFileLease } from '../runtime/windows-file-lease.js';

export function createLocalFileLease({ subjectPath, platform = process.platform, holderExecutable = path.join(path.dirname(process.execPath), 'devbridge-lifecycle-authority-host.exe') } = {}) {
  // Read-only composition does not need a platform mutation capability. Resolve
  // it only when a consumer actually requests exclusive ownership.
  return Object.freeze({
    async acquire(request) {
      if (platform === 'linux') return createLinuxFileLease({ subjectPath }).acquire(request);
      if (platform === 'win32') return createWindowsFileLease({ subjectPath, holderExecutable }).acquire(request);
      throw new Error('no local mutation lease is available on this host');
    },
  });
}
