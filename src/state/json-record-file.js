import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('record file root must be an object');
  }
  return value;
}

async function readDocument(target) {
  try {
    return normalizeDocument(JSON.parse(await readFile(target, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {};
  }
}

async function readExact(target) {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  }
}

export function createJsonRecordFile(target, { identifier = randomUUID } = {}) {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) throw new TypeError('record file target is invalid');
  if (typeof identifier !== 'function') throw new TypeError('record file identity dependency is invalid');
  const resolved = path.resolve(target);

  return Object.freeze({
    read: () => readDocument(resolved),
    async replace(value) {
      const document = normalizeDocument(value);
      const suffix = identifier();
      if (typeof suffix !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(suffix)) throw new TypeError('record file temporary identity is invalid');
      await mkdir(path.dirname(resolved), { recursive: true });
      const temporary = `${resolved}.${suffix}.tmp`;
      const expected = `${JSON.stringify(document, null, 2)}\n`;
      let handle = null;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(expected, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        try {
          await rename(temporary, resolved);
        } catch (error) {
          if (await readExact(resolved) !== expected) throw error;
        }
        if (await readExact(resolved) !== expected) throw new Error('record file replacement did not re-observe exactly');
      } finally {
        await handle?.close();
        await rm(temporary, { force: true });
      }
    },
  });
}
