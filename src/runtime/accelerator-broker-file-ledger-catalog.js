import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import {
  acceleratorBrokerLedgerKey,
  normalizeAcceleratorBrokerLedgerRecord,
} from './accelerator-broker-ledger.js';
import {
  createAcceleratorBrokerGenerationObservation,
  normalizeAcceleratorBrokerGenerationSelector,
} from './accelerator-broker-generation-catalog.js';
import {
  ACCELERATOR_BROKER_FILE_LEDGER_MAX_RECORD_BYTES,
  FileAcceleratorBrokerLedgerStore,
} from './accelerator-broker-file-ledger.js';

const MAX_RECORD_BYTES_LIMIT = 8 * 1024 * 1024;
const FANOUT_DIRECTORY = /^[0-9a-f]{2}$/u;
const KEY_DIRECTORY = /^[0-9a-f]{64}$/u;
const FIRST_REVISION_FILE = '0000000000000001.json';
const TEMP_FILE = /^\.tmp-[0-9a-f-]{36}\.json$/iu;

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

export class FileAcceleratorBrokerGenerationCatalog {
  #rootPath;
  #maxRecordBytes;
  #store;

  constructor({ rootPath, maxRecordBytes = ACCELERATOR_BROKER_FILE_LEDGER_MAX_RECORD_BYTES } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new TypeError('accelerator broker file ledger catalog rootPath must be absolute');
    }
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 || maxRecordBytes > MAX_RECORD_BYTES_LIMIT) {
      throw new TypeError('accelerator broker file ledger catalog maxRecordBytes is invalid');
    }
    this.#rootPath = path.resolve(rootPath);
    this.#maxRecordBytes = maxRecordBytes;
    this.#store = new FileAcceleratorBrokerLedgerStore({ rootPath: this.#rootPath, maxRecordBytes });
  }

  async #validateDirectory(directoryPath, name) {
    let info;
    try { info = await lstat(directoryPath); }
    catch (error) {
      if (error?.code === 'ENOENT') throw policy(`accelerator broker file ledger catalog ${name} is unavailable`);
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw policy(`accelerator broker file ledger catalog ${name} is invalid`);
    let resolved;
    try { resolved = await realpath(directoryPath); }
    catch { throw policy(`accelerator broker file ledger catalog ${name} cannot be resolved`); }
    if (!samePath(resolved, directoryPath)) throw policy(`accelerator broker file ledger catalog ${name} is not canonical`);
  }

  async #validateRoot() {
    await this.#validateDirectory(this.#rootPath, 'root');
  }

  async #readFirstRecord(keyPath) {
    const entries = await readdir(keyPath, { withFileTypes: true });
    const first = entries.find((entry) => entry.name === FIRST_REVISION_FILE);
    if (!first) {
      for (const entry of entries) {
        if (TEMP_FILE.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) continue;
        throw policy('accelerator broker file ledger catalog key has no published first revision');
      }
      return null;
    }
    if (!first.isFile() || first.isSymbolicLink()) throw policy('accelerator broker file ledger catalog first revision is invalid');
    const firstPath = path.join(keyPath, FIRST_REVISION_FILE);
    let info;
    try { info = await lstat(firstPath); }
    catch { throw policy('accelerator broker file ledger catalog first revision is unavailable'); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > this.#maxRecordBytes) {
      throw policy('accelerator broker file ledger catalog first revision is invalid');
    }
    let resolved;
    try { resolved = await realpath(firstPath); }
    catch { throw policy('accelerator broker file ledger catalog first revision cannot be resolved'); }
    if (!samePath(resolved, firstPath)) throw policy('accelerator broker file ledger catalog first revision is not canonical');

    let handle = null;
    let text;
    try {
      handle = await open(firstPath, 'r');
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > this.#maxRecordBytes) {
        throw policy('accelerator broker file ledger catalog first revision is invalid');
      }
      text = await handle.readFile({ encoding: 'utf8' });
    } finally {
      if (handle) await handle.close();
    }
    if (Buffer.byteLength(text, 'utf8') > this.#maxRecordBytes) {
      throw policy('accelerator broker file ledger catalog first revision is oversized');
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw policy('accelerator broker file ledger catalog first revision is malformed'); }
    let record;
    try { record = normalizeAcceleratorBrokerLedgerRecord(parsed); }
    catch { throw policy('accelerator broker file ledger catalog first revision is malformed'); }
    if (record.revision !== 1) throw policy('accelerator broker file ledger catalog first revision identity is invalid');
    return record;
  }

  async #records() {
    await this.#validateRoot();
    const records = [];
    const seen = new Set();
    const fanoutEntries = await readdir(this.#rootPath, { withFileTypes: true });
    for (const fanoutEntry of fanoutEntries) {
      if (!FANOUT_DIRECTORY.test(fanoutEntry.name) || !fanoutEntry.isDirectory() || fanoutEntry.isSymbolicLink()) {
        throw policy('accelerator broker file ledger catalog contains an unexpected root entry');
      }
      const fanoutPath = path.join(this.#rootPath, fanoutEntry.name);
      await this.#validateDirectory(fanoutPath, 'fanout directory');
      const keyEntries = await readdir(fanoutPath, { withFileTypes: true });
      for (const keyEntry of keyEntries) {
        if (!KEY_DIRECTORY.test(keyEntry.name) || !keyEntry.isDirectory() || keyEntry.isSymbolicLink()) {
          throw policy('accelerator broker file ledger catalog contains an unexpected key entry');
        }
        const keyPath = path.join(fanoutPath, keyEntry.name);
        await this.#validateDirectory(keyPath, 'key directory');
        const first = await this.#readFirstRecord(keyPath);
        if (!first) continue;
        const key = acceleratorBrokerLedgerKey(first.request);
        const encodedKey = JSON.stringify(key);
        if (seen.has(encodedKey)) throw policy('accelerator broker file ledger catalog contains a duplicate logical key');
        seen.add(encodedKey);
        const current = await this.#store.load(key);
        if (!current) throw policy('accelerator broker file ledger catalog key is outside the store-owned layout');
        records.push(current);
      }
    }
    return Object.freeze(records);
  }

  async observeGeneration(rawSelector) {
    const selector = normalizeAcceleratorBrokerGenerationSelector(rawSelector);
    return createAcceleratorBrokerGenerationObservation(selector, await this.#records());
  }
}
