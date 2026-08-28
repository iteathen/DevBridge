import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function requireProtocol(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('ledger protocol is required');
  return value;
}

function emptyState(protocol) {
  return { protocol, revision: 0, entries: {}, operations: {} };
}

export class EnvironmentLedger {
  #directory;
  #stateFile;
  #guardFile;
  #protocol;
  #tail = Promise.resolve();

  constructor({ directory, protocol }) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('ledger directory is required');
    this.#directory = path.resolve(directory);
    this.#stateFile = path.join(this.#directory, 'catalog.json');
    this.#guardFile = path.join(this.#directory, 'lifecycle.lock');
    this.#protocol = requireProtocol(protocol);
  }

  async #ensureDirectory() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment directory must be a real directory');
  }

  async #acquire() {
    await this.#ensureDirectory();
    const token = randomUUID();
    let handle;
    try {
      handle = await open(this.#guardFile, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('environment lifecycle mutation is already active; remove lifecycle.lock only after confirming no operation is running');
      }
      throw error;
    }
    try {
      await handle.writeFile(`${token}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(this.#guardFile, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    return async () => {
      const observed = (await readFile(this.#guardFile, 'utf8')).trim();
      if (observed !== token) throw new Error('environment lifecycle guard ownership changed');
      await rm(this.#guardFile);
    };
  }

  run(work) {
    if (typeof work !== 'function') throw new TypeError('ledger work must be a function');
    const guarded = async () => {
      const release = await this.#acquire();
      try { return await work(); }
      finally { await release(); }
    };
    const next = this.#tail.then(guarded, guarded);
    this.#tail = next.catch(() => {});
    return next;
  }

  async read() {
    await this.#ensureDirectory();
    try {
      const info = await lstat(this.#stateFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment catalog must be a real file');
      const state = JSON.parse(await readFile(this.#stateFile, 'utf8'));
      if (!state || state.protocol !== this.#protocol || !state.entries || !state.operations) throw new Error('environment catalog is invalid');
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState(this.#protocol);
      throw error;
    }
  }

  async commit(state) {
    state.revision = Number(state.revision ?? 0) + 1;
    const temporary = path.join(this.#directory, `.catalog-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.#stateFile);
  }
}
