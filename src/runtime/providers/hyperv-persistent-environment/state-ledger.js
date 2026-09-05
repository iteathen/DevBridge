import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/hyperv-persistent-environment-v1';

export class HyperVEnvironmentLedger {
  #directory;
  #stateFile;

  constructor({ directory }) {
    this.#directory = path.resolve(directory);
    this.#stateFile = path.join(this.#directory, 'state.json');
  }

  async ensure() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment storage root must be a real directory');
    const objects = path.join(this.#directory, 'objects');
    await mkdir(objects, { recursive: true, mode: 0o700 });
    const objectInfo = await lstat(objects);
    if (!objectInfo.isDirectory() || objectInfo.isSymbolicLink()) throw new Error('environment object root must be a real directory');
  }

  async load() {
    await this.ensure();
    try {
      const info = await lstat(this.#stateFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment adapter state must be a real file');
      const state = JSON.parse(await readFile(this.#stateFile, 'utf8'));
      if (!state || state.protocol !== PROTOCOL || !state.records) throw new Error('environment adapter state is invalid');
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return { protocol: PROTOCOL, records: {} };
      throw error;
    }
  }

  async save(state) {
    await this.ensure();
    const temporary = path.join(this.#directory, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.#stateFile);
  }
}
