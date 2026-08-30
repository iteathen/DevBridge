import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
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
  if (left.ino === 0n || right.ino === 0n || left.ino !== right.ino) return false;
  if (left.dev === 0n || right.dev === 0n) return process.platform === 'win32';
  return left.dev === right.dev;
}

export function createProcessActivityLease({ protocol, fileName }) {
  if (typeof protocol !== 'string' || protocol.length < 1) throw new TypeError('activity protocol must be non-empty text');
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName) throw new TypeError('activity fileName must be one safe name');

  function read(lockPath) {
    let descriptor;
    try {
      const before = lstatSync(lockPath, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n
          || before.size > BigInt(MAX_RECORD_BYTES)) fail('Activity lease state is invalid.');
      descriptor = openSync(lockPath, 'r');
      const held = fstatSync(descriptor, { bigint: true });
      if (!held.isFile() || held.nlink !== 1n || held.size !== before.size || !sameFileIdentity(before, held)) {
        fail('Activity lease state changed while opening.');
      }
      const bytes = readFileSync(descriptor);
      const heldAfter = fstatSync(descriptor, { bigint: true });
      const after = lstatSync(lockPath, { bigint: true });
      if (!heldAfter.isFile() || heldAfter.nlink !== 1n || heldAfter.size !== held.size
          || !sameFileIdentity(held, heldAfter) || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n
          || after.size !== held.size || !sameFileIdentity(held, after) || BigInt(bytes.length) !== held.size) {
        fail('Activity lease state changed during observation.');
      }
      const record = JSON.parse(bytes.toString('utf8'));
      if (record?.protocol !== protocol
          || !Number.isSafeInteger(record.pid) || record.pid <= 0
          || typeof record.token !== 'string' || !/^[0-9a-f-]{36}$/u.test(record.token)
          || !Number.isSafeInteger(record.startedAt) || record.startedAt <= 0) {
        fail('Activity lease state is invalid.');
      }
      return { info: after, record };
    } finally {
      if (descriptor != null) closeSync(descriptor);
    }
  }

  function acquire(root) {
    const lockPath = path.join(root, fileName);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = randomUUID();
      const temporary = path.join(root, `.activity-lease-${process.pid}-${token}.tmp`);
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
              // Cleanup is deliberately non-authoritative after the protected activity.
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
      if (processIsLive(occupied.record.pid)) fail('Another protected activity is active for this root.');

      let current;
      try { current = lstatSync(lockPath, { bigint: true }); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!sameFileIdentity(occupied.info, current)) continue;
      unlinkSync(lockPath);
    }
    fail('Could not acquire the activity lease safely.');
  }

  function observe(root) {
    const lockPath = path.join(root, fileName);
    try {
      const occupied = read(lockPath);
      return Object.freeze({ active: processIsLive(occupied.record.pid) });
    } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ active: false });
      throw error;
    }
  }

  return Object.freeze({ acquire, observe });
}
