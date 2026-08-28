import { readFile } from 'node:fs/promises';

const TRANSIENT_ACCESS_CODE = 'EPERM';
const RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80]);

function defaultWait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function readBoundedText(filePath, { read = readFile, wait = defaultWait } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
    throw new TypeError('text source path is invalid');
  }
  if (typeof read !== 'function') throw new TypeError('text read port is invalid');
  if (typeof wait !== 'function') throw new TypeError('wait port is invalid');

  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = await read(filePath, 'utf8');
      if (typeof text !== 'string') throw new TypeError('text read port returned a non-text value');
      return text;
    } catch (error) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      if (error?.code !== TRANSIENT_ACCESS_CODE || delayMs == null) throw error;
      await wait(delayMs);
    }
  }
}
