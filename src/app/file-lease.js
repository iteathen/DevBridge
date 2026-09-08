import path from 'node:path';
import { createLinuxFileLease } from '../runtime/linux-file-lease.js';
import { createWindowsFileLease } from '../runtime/windows-file-lease.js';

export function createLocalFileLease({ subjectPath, platform = process.platform, holderExecutable = path.join(path.dirname(process.execPath), 'devbridge-lifecycle-authority-host.exe') } = {}) {
  if (platform === 'linux') return createLinuxFileLease({ subjectPath });
  if (platform === 'win32') return createWindowsFileLease({ subjectPath, holderExecutable });
  return Object.freeze({ async acquire() { throw new Error('no local mutation lease is available on this host'); } });
}
