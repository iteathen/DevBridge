import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

const TOKEN = /^[a-f0-9-]{16,128}$/u;
const MAX_RECORD_BYTES = 512;

function identityOf(info) {
  return Object.freeze({
    device: info.dev,
    inode: info.ino,
    birthtimeNanoseconds: info.birthtimeNs,
    changeTimeNanoseconds: info.ctimeNs,
  });
}

function sameHandleIdentity(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.birthtimeNanoseconds === right.birthtimeNanoseconds
    && left.changeTimeNanoseconds === right.changeTimeNanoseconds;
}

function samePathIdentity(info, identity) {
  return info.ino === identity.inode
    && info.birthtimeNs === identity.birthtimeNanoseconds
    && info.ctimeNs === identity.changeTimeNanoseconds;
}

function ownerValue(protocol, token) {
  return `${JSON.stringify({ protocol, token, pid: process.pid })}\n`;
}

async function releaseOwned(location, owner, acquiredIdentity) {
  let observed;
  try { observed = await lstat(location, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!observed.isFile() || observed.isSymbolicLink() || observed.size < 1n || observed.size > BigInt(MAX_RECORD_BYTES) || !samePathIdentity(observed, acquiredIdentity)) return false;

  let handle;
  try { handle = await open(location, 'r'); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  try {
    const throughHandle = await handle.stat({ bigint: true });
    if (!throughHandle.isFile() || throughHandle.size !== BigInt(Buffer.byteLength(owner, 'utf8')) || !sameHandleIdentity(identityOf(throughHandle), acquiredIdentity)) return false;
    if (await handle.readFile('utf8') !== owner) return false;
  } finally {
    await handle.close();
  }

  try { observed = await lstat(location, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!observed.isFile() || observed.isSymbolicLink() || observed.size !== BigInt(Buffer.byteLength(owner, 'utf8')) || !samePathIdentity(observed, acquiredIdentity)) return false;
  await unlink(location);
  return true;
}

export function createMutationLease({ protocol, conflictMessage, createToken = randomUUID }) {
  if (typeof protocol !== 'string' || protocol.length === 0 || Buffer.byteLength(protocol, 'utf8') > 160) throw new TypeError('mutation lease protocol is invalid');
  if (typeof conflictMessage !== 'string' || conflictMessage.length === 0 || Buffer.byteLength(conflictMessage, 'utf8') > 512) throw new TypeError('mutation lease conflict message is invalid');
  if (typeof createToken !== 'function') throw new TypeError('mutation lease token contract is invalid');

  const run = async (location, work) => {
    if (typeof location !== 'string' || location.length === 0 || location.includes('\0') || !path.isAbsolute(location)) throw new TypeError('mutation lease location must be an absolute local path');
    if (typeof work !== 'function') throw new TypeError('mutation lease work must be a function');
    const token = createToken();
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new TypeError('mutation lease token is invalid');
    const owner = ownerValue(protocol, token);
    if (Buffer.byteLength(owner, 'utf8') > MAX_RECORD_BYTES) throw new TypeError('mutation lease owner record is invalid');

    await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
    let handle;
    try { handle = await open(location, 'wx', 0o600); }
    catch (error) {
      if (error?.code === 'EEXIST') throw new Error(conflictMessage);
      throw error;
    }

    let acquiredIdentity;
    try {
      await handle.writeFile(owner, 'utf8');
      await handle.sync();
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) throw new Error('mutation lease owner record is not a regular file');
      acquiredIdentity = identityOf(info);
      return await work();
    } finally {
      await handle.close().catch(() => {});
      if (acquiredIdentity) await releaseOwned(location, owner, acquiredIdentity).catch(() => false);
    }
  };

  return Object.freeze({ run });
}
