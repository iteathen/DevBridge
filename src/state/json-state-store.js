import { createJsonRecordFile } from './json-record-file.js';

export class JsonStateStore {
  #file;
  #loading = null;
  #data = {};
  #writeChain = Promise.resolve();

  constructor(filePath, { file = createJsonRecordFile(filePath) } = {}) {
    if (!file || typeof file.read !== 'function' || typeof file.replace !== 'function') throw new TypeError('JSON state file contract is incomplete');
    this.#file = file;
  }

  async #load() {
    if (!this.#loading) this.#loading = this.#file.read().then(value => { this.#data = value; }).catch(error => { this.#loading = null; throw error; });
    await this.#loading;
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
    const selected = structuredClone(value);
    return this.#queueWrite(data => { data[key] = selected; });
  }

  async delete(key) {
    await this.#load();
    return this.#queueWrite(data => { delete data[key]; });
  }

  async #queueWrite(change) {
    const operation = this.#writeChain.then(async () => {
      const next = structuredClone(this.#data);
      change(next);
      await this.#file.replace(next);
      this.#data = next;
    });
    this.#writeChain = operation.catch(() => {});
    return operation;
  }
}
