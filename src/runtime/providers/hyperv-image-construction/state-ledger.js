import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/hyperv-image-construction-v2';

export class HyperVConstructionLedger {
  #roots;
  #directory;
  #stateFile;

  constructor({ directory, sourceRoot, outputRoot }) {
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
      if (!state || state.protocol !== PROTOCOL || !state.records || typeof state.records !== 'object') throw new Error('construction state protocol is invalid');
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
