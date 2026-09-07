import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sameFilesystemIdentity, sameObservedFilesystemIdentity } from '../local-filesystem-identity.js';
import {
  immutableObjectSourceAbort,
  normalizeImmutableObjectSourceRequest,
} from './request.js';

const READ_BYTES = 4 * 1024 * 1024;

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function requireRealDirectory(directory) {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('immutable object filesystem source must be a real directory');
  const canonical = await realpath(directory);
  if (!await sameFilesystemIdentity(directory, canonical)) throw new Error('immutable object filesystem source uses filesystem indirection');
}

async function* heldFileBody({ location, before, size, signal }) {
  const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, size));
  let offset = 0;
  immutableObjectSourceAbort(signal);
  const handle = await open(location, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) {
      throw new Error('immutable object filesystem source changed while opening');
    }
    while (offset < size) {
      immutableObjectSourceAbort(signal);
      const requested = Math.min(buffer.length, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead !== requested) throw new Error('immutable object filesystem source ended while reading');
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      throw new Error('immutable object filesystem source grew while reading');
    }
    const after = await lstat(location, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(held, after)) {
      throw new Error('immutable object filesystem source changed while reading');
    }
  } finally { await handle.close(); }
}

export class FilesystemImmutableObjectSource {
  #directory;

  constructor({ directory } = {}) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0') || !path.isAbsolute(directory)) {
      throw new TypeError('immutable object filesystem source directory is invalid');
    }
    this.#directory = path.resolve(directory);
  }

  async fetch(raw) {
    const request = normalizeImmutableObjectSourceRequest(raw);
    immutableObjectSourceAbort(request.signal);
    await requireRealDirectory(this.#directory);
    const location = path.join(this.#directory, request.chunk.sha256);
    const before = await lstat(location, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error('immutable object filesystem source has an unsafe file shape');
    }
    if (before.size !== BigInt(request.chunk.size)) {
      throw new Error('immutable object filesystem source byte count does not match authority');
    }
    return Object.freeze({ body: heldFileBody({ location, before, size: request.chunk.size, signal: request.signal }) });
  }
}
