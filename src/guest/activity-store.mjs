import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ATTEMPT_PROTOCOL = 'devbridge/activity-attempt-v1';
const ACTIVITY_PROTOCOL = 'devbridge/activity-observation-v1';
const IDENTITY = /^[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_ACTIVITY_AGE_MS = 10_000;
const MAX_RECORD_BYTES = 4_096;
const RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80, 160]);

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function validIdentity(value) {
  if (typeof value !== 'string' || !IDENTITY.test(value)) throw new TypeError('activity identity is invalid');
  return value;
}

function validToken(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new TypeError('activity token is invalid');
  return value;
}

async function ownedDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('activity directory must be a real directory');
  return realpath(directory);
}

async function atomicRecord(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        const retry = process.platform === 'win32'
          && RENAME_RETRY_CODES.has(error?.code)
          && attempt < RENAME_RETRY_DELAYS_MS.length;
        if (!retry) throw error;
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
      }
    }
  } catch (error) {
    try { await rm(temporary, { force: true }); } catch {}
    throw error;
  }
}

export async function createActivityStore({ directory }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('activity directory must be absolute');
  const root = await ownedDirectory(path.resolve(directory));
  const attemptFile = (identity) => path.join(root, `${validIdentity(identity)}.attempt.json`);
  const activityFile = (identity, token) => path.join(root, `${validIdentity(identity)}.activity.${validToken(token)}.json`);

  return Object.freeze({
    async claim(identity, token) {
      const file = attemptFile(identity);
      let handle;
      try {
        handle = await open(file, 'wx', 0o600);
      } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
      }
      try {
        await handle.writeFile(`${JSON.stringify({ protocol: ATTEMPT_PROTOCOL, identity, token, createdAt: Date.now() })}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return true;
    },

    async attempted(identity) {
      try {
        await lstat(attemptFile(identity));
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    },

    async publish(identity, token) {
      validIdentity(identity);
      validToken(token);
      await atomicRecord(activityFile(identity, token), {
        protocol: ACTIVITY_PROTOCOL,
        identity,
        token,
        updatedAt: Date.now(),
      });
    },

    async inspect(identity, token) {
      const file = activityFile(identity, token);
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_RECORD_BYTES) return 'invalid';
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || !exactKeys(value, ['identity', 'protocol', 'token', 'updatedAt'])
          || value.protocol !== ACTIVITY_PROTOCOL
          || value.identity !== identity
          || value.token !== token
          || !Number.isSafeInteger(value.updatedAt)) return 'invalid';
        const age = Date.now() - value.updatedAt;
        if (age < 0) return 'invalid';
        return age <= MAX_ACTIVITY_AGE_MS ? 'current' : 'stale';
      } catch (error) {
        if (error?.code === 'ENOENT') return 'absent';
        return 'invalid';
      }
    },

    async remove(identity, token) {
      await rm(activityFile(identity, token), { force: true });
    },
  });
}
