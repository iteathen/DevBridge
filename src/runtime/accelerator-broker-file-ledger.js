import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import {
  acceleratorBrokerLedgerKey,
  assertAcceleratorBrokerLedgerRecordTransition,
  normalizeAcceleratorBrokerLedgerKey,
  normalizeAcceleratorBrokerLedgerRecord,
} from './accelerator-broker-ledger.js';

export const ACCELERATOR_BROKER_FILE_LEDGER_MAX_RECORD_BYTES = 512 * 1024;

const MAX_RECORD_BYTES_LIMIT = 8 * 1024 * 1024;
const REVISION_WIDTH = 16;
const REVISION_FILE = /^([0-9]{16})\.json$/u;
const TEMP_FILE = /^\.tmp-[0-9a-f-]{36}\.json$/iu;
const PUBLISH_COLLISION_CODES = new Set(['EEXIST', 'EPERM', 'EACCES']);

function policy(message) {
  return new PolicyError(message);
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function sameKey(left, right) {
  return left.sessionIdentity === right.sessionIdentity
    && left.sessionGeneration === right.sessionGeneration
    && left.requestId === right.requestId;
}

function revisionFileName(revision) {
  return `${String(revision).padStart(REVISION_WIDTH, '0')}.json`;
}

function keyDigest(key) {
  return createHash('sha256')
    .update('devbridge/accelerator-broker-file-ledger-key-v1\0')
    .update(JSON.stringify(key))
    .digest('hex');
}

async function unlinkOwnedTemp(filePath) {
  try { await unlink(filePath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

export class FileAcceleratorBrokerLedgerStore {
  #rootPath;
  #maxRecordBytes;

  constructor({ rootPath, maxRecordBytes = ACCELERATOR_BROKER_FILE_LEDGER_MAX_RECORD_BYTES } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new TypeError('accelerator broker file ledger rootPath must be absolute');
    }
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 || maxRecordBytes > MAX_RECORD_BYTES_LIMIT) {
      throw new TypeError('accelerator broker file ledger maxRecordBytes is invalid');
    }
    this.#rootPath = path.resolve(rootPath);
    this.#maxRecordBytes = maxRecordBytes;
  }

  async #validateDirectory(directoryPath, { missing = false, canonicalRoot = false } = {}) {
    let info;
    try { info = await lstat(directoryPath); }
    catch (error) {
      if (missing && error?.code === 'ENOENT') return false;
      if (error?.code === 'ENOENT') throw policy('accelerator broker file ledger directory is unavailable');
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw policy('accelerator broker file ledger directory is invalid');
    let resolved;
    try { resolved = await realpath(directoryPath); }
    catch { throw policy('accelerator broker file ledger directory cannot be resolved'); }
    if (!samePath(resolved, directoryPath)) throw policy('accelerator broker file ledger directory is not canonical');
    if (canonicalRoot && !samePath(resolved, this.#rootPath)) throw policy('accelerator broker file ledger root is not canonical');
    return true;
  }

  async #validateRoot() {
    await this.#validateDirectory(this.#rootPath, { canonicalRoot: true });
  }

  #paths(rawKey) {
    const key = normalizeAcceleratorBrokerLedgerKey(rawKey);
    const digest = keyDigest(key);
    const fanoutPath = path.join(this.#rootPath, digest.slice(0, 2));
    const keyPath = path.join(fanoutPath, digest);
    return Object.freeze({ key, digest, fanoutPath, keyPath });
  }

  async #ensureDirectory(directoryPath) {
    try { await mkdir(directoryPath, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    await this.#validateDirectory(directoryPath);
  }

  async #ensureKeyDirectory(paths) {
    await this.#ensureDirectory(paths.fanoutPath);
    await this.#ensureDirectory(paths.keyPath);
  }

  async #existingKeyDirectory(paths) {
    if (!(await this.#validateDirectory(paths.fanoutPath, { missing: true }))) return false;
    return this.#validateDirectory(paths.keyPath, { missing: true });
  }

  async #readRevisionFile(filePath, expectedRevision, key) {
    let info;
    try { info = await lstat(filePath); }
    catch (error) {
      if (error?.code === 'ENOENT') throw policy('accelerator broker file ledger revision disappeared');
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw policy('accelerator broker file ledger revision is not a regular file');
    let resolved;
    try { resolved = await realpath(filePath); }
    catch { throw policy('accelerator broker file ledger revision cannot be resolved'); }
    if (!samePath(resolved, filePath)) throw policy('accelerator broker file ledger revision path is not canonical');
    if (info.size > this.#maxRecordBytes) throw policy('accelerator broker file ledger revision is oversized');

    let handle = null;
    let text;
    try {
      handle = await open(filePath, 'r');
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > this.#maxRecordBytes) throw policy('accelerator broker file ledger revision is invalid');
      text = await handle.readFile({ encoding: 'utf8' });
    } finally {
      if (handle) await handle.close();
    }
    if (Buffer.byteLength(text, 'utf8') > this.#maxRecordBytes) throw policy('accelerator broker file ledger revision is oversized');

    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw policy('accelerator broker file ledger revision is malformed'); }
    let record;
    try { record = normalizeAcceleratorBrokerLedgerRecord(parsed); }
    catch { throw policy('accelerator broker file ledger revision is malformed'); }
    if (record.revision !== expectedRevision) throw policy('accelerator broker file ledger revision identity does not match its filename');
    if (!sameKey(acceleratorBrokerLedgerKey(record.request), key)) throw policy('accelerator broker file ledger revision belongs to another key');
    return record;
  }

  async #loadFromKeyDirectory(paths) {
    let entries;
    try { entries = await readdir(paths.keyPath, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }

    const revisions = [];
    for (const entry of entries) {
      const match = REVISION_FILE.exec(entry.name);
      if (match) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw policy('accelerator broker file ledger contains an invalid revision entry');
        const value = Number(match[1]);
        if (!Number.isSafeInteger(value) || value < 1) throw policy('accelerator broker file ledger contains an invalid revision filename');
        revisions.push(value);
        continue;
      }
      if (TEMP_FILE.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw policy('accelerator broker file ledger contains an invalid temporary entry');
        continue;
      }
      throw policy('accelerator broker file ledger contains an unexpected entry');
    }

    if (revisions.length === 0) return null;
    revisions.sort((left, right) => left - right);
    for (let index = 0; index < revisions.length; index += 1) {
      if (revisions[index] !== index + 1) throw policy('accelerator broker file ledger revision history is not contiguous');
    }

    let previous = null;
    for (const revision of revisions) {
      const current = await this.#readRevisionFile(path.join(paths.keyPath, revisionFileName(revision)), revision, paths.key);
      if (previous) {
        try { assertAcceleratorBrokerLedgerRecordTransition(previous, current); }
        catch { throw policy('accelerator broker file ledger revision history is inconsistent'); }
      }
      previous = current;
    }
    return previous;
  }

  async #serialize(record) {
    const normalized = normalizeAcceleratorBrokerLedgerRecord(record);
    const payload = `${JSON.stringify(normalized)}\n`;
    if (Buffer.byteLength(payload, 'utf8') > this.#maxRecordBytes) throw policy('accelerator broker file ledger record is oversized');
    return Object.freeze({ normalized, payload });
  }

  async #publish(paths, record) {
    const { normalized, payload } = await this.#serialize(record);
    const finalPath = path.join(paths.keyPath, revisionFileName(normalized.revision));
    const tempPath = path.join(paths.keyPath, `.tmp-${randomUUID()}.json`);
    let handle = null;
    try {
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await link(tempPath, finalPath);
        return true;
      } catch (error) {
        if (!PUBLISH_COLLISION_CODES.has(error?.code)) throw error;
        let finalExists = false;
        try {
          const info = await lstat(finalPath);
          finalExists = info.isFile() && !info.isSymbolicLink();
        } catch (readError) {
          if (readError?.code !== 'ENOENT') throw readError;
        }
        if (!finalExists) throw error;
        await this.#readRevisionFile(finalPath, normalized.revision, paths.key);
        return false;
      }
    } finally {
      if (handle) { try { await handle.close(); } catch {} }
      await unlinkOwnedTemp(tempPath);
    }
  }

  async load(rawKey) {
    await this.#validateRoot();
    const paths = this.#paths(rawKey);
    if (!(await this.#existingKeyDirectory(paths))) return null;
    return this.#loadFromKeyDirectory(paths);
  }

  async create(rawKey, rawRecord) {
    await this.#validateRoot();
    const paths = this.#paths(rawKey);
    const record = normalizeAcceleratorBrokerLedgerRecord(rawRecord);
    if (record.revision !== 1) throw new TypeError('accelerator broker file ledger create requires revision 1');
    if (!sameKey(acceleratorBrokerLedgerKey(record.request), paths.key)) throw new TypeError('accelerator broker file ledger record key does not match create key');
    await this.#ensureKeyDirectory(paths);
    const current = await this.#loadFromKeyDirectory(paths);
    if (current) return false;
    return this.#publish(paths, record);
  }

  async compareAndSwap(rawKey, expectedRevision, rawRecord) {
    await this.#validateRoot();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new TypeError('accelerator broker file ledger expectedRevision is invalid');
    }
    const paths = this.#paths(rawKey);
    const record = normalizeAcceleratorBrokerLedgerRecord(rawRecord);
    if (record.revision !== expectedRevision + 1) {
      throw new TypeError('accelerator broker file ledger CAS record revision is invalid');
    }
    if (!sameKey(acceleratorBrokerLedgerKey(record.request), paths.key)) throw new TypeError('accelerator broker file ledger record key does not match CAS key');
    if (!(await this.#existingKeyDirectory(paths))) return false;
    const current = await this.#loadFromKeyDirectory(paths);
    if (!current || current.revision !== expectedRevision) return false;
    try { assertAcceleratorBrokerLedgerRecordTransition(current, record); }
    catch { throw new TypeError('accelerator broker file ledger CAS transition is invalid'); }
    return this.#publish(paths, record);
  }
}
