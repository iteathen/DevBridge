import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class JsonStateStore {
  #filePath;
  #loaded = false;
  #data = {};
  #writeChain = Promise.resolve();

  constructor(filePath) {
    this.#filePath = filePath;
  }

  async #load() {
    if (this.#loaded) return;
    try {
      const text = await readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(text);
      this.#data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#data = {};
    }
    this.#loaded = true;
  }

  async get(key) {
    await this.#load();
    return structuredClone(this.#data[key]);
  }

  async entries(prefix = '') {
    await this.#load();
    return Object.entries(this.#data)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key, structuredClone(value)]);
  }

  async set(key, value) {
    await this.#load();
    this.#data[key] = structuredClone(value);
    return this.#queueWrite();
  }

  async delete(key) {
    await this.#load();
    delete this.#data[key];
    return this.#queueWrite();
  }

  async #queueWrite() {
    this.#writeChain = this.#writeChain.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temp = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, `${JSON.stringify(this.#data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.#filePath);
    });
    return this.#writeChain;
  }
}
