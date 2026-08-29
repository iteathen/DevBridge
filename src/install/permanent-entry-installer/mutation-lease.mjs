import { randomUUID } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MAX_RECORD_BYTES = 4096;

function fail(message) { throw new Error(message); }

function processIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function createMutationLease({ protocol, fileName }) {
  if (typeof protocol !== 'string' || protocol.length < 1) throw new TypeError('protocol must be non-empty text');
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName) throw new TypeError('fileName must be one safe name');

  function read(lockPath) {
    const info = lstatSync(lockPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_RECORD_BYTES) {
      fail('Mutation lease state is invalid.');
    }
    const record = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (record?.protocol !== protocol ||
        !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
        typeof record.token !== 'string' || !/^[0-9a-f-]{36}$/u.test(record.token) ||
        !Number.isSafeInteger(record.startedAt) || record.startedAt <= 0) {
      fail('Mutation lease state is invalid.');
    }
    return { info, record };
  }

  function acquire(root) {
    const lockPath = path.join(root, fileName);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = randomUUID();
      const temporary = path.join(root, `.mutation-lease-${process.pid}-${token}.tmp`);
      const record = Object.freeze({ protocol, pid: process.pid, startedAt: Date.now(), token });
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try {
        linkSync(temporary, lockPath);
        unlinkSync(temporary);
        return () => {
          try {
            const current = read(lockPath);
            if (current.record.token === token && current.record.pid === process.pid) unlinkSync(lockPath);
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              // Lease cleanup is deliberately non-authoritative after the mutation.
            }
          }
        };
      } catch (error) {
        try { unlinkSync(temporary); } catch {}
        if (error?.code !== 'EEXIST') throw error;
      }

      let occupied;
      try { occupied = read(lockPath); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (processIsLive(occupied.record.pid)) fail('Another installation mutation is active for this root.');

      let current;
      try { current = lstatSync(lockPath); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!sameFileIdentity(occupied.info, current)) continue;
      unlinkSync(lockPath);
    }
    fail('Could not acquire the installation mutation lease safely.');
  }

  return Object.freeze({ acquire });
}
