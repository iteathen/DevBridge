import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/hyperv-image-construction-v2';
const DATA_PROTOCOL = 'devbridge/hyperv-image-construction-v3';

export class HyperVConstructionLedger {
  #roots;
  #directory;
  #stateFile;
  #validateRecord;

  constructor({ directory, sourceRoot, outputRoot, validateRecord }) {
    if (typeof validateRecord !== 'function') throw new TypeError('construction record validator is required');
    this.#validateRecord = validateRecord;
    this.#directory = path.resolve(directory);
    this.#roots = [this.#directory, path.resolve(sourceRoot), path.resolve(outputRoot)];
    this.#stateFile = path.join(this.#directory, 'state.json');
  }

  async ensure() {
    for (const directory of this.#roots) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('construction control roots must be real directories');
    }
  }

  async load() {
    await this.ensure();
    try {
      const info = await lstat(this.#stateFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('construction state is invalid');
      const state = JSON.parse(await readFile(this.#stateFile, 'utf8'));
      if (!state || ![PROTOCOL, DATA_PROTOCOL].includes(state.protocol) || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) throw new Error('construction state protocol is invalid');
      for (const record of Object.values(state.records)) this.#validateRecord(record);
      if (state.protocol === PROTOCOL && Object.values(state.records).some((record) => Object.hasOwn(record, 'dataMedia'))) throw new Error('construction data media requires versioned state');
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return { protocol: PROTOCOL, records: {} };
      throw error;
    }
  }

  async save(state) {
    await this.ensure();
    for (const record of Object.values(state.records)) this.#validateRecord(record);
    if (Object.values(state.records).some((record) => Object.hasOwn(record, 'dataMedia'))) state.protocol = DATA_PROTOCOL;
    const temporary = path.join(this.#directory, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.#stateFile);
  }
}
