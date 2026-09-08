import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  #lease;
  #held = null;
  #tail = Promise.resolve();

  constructor({ directory, protocol, lease }) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('ledger directory is required');
    this.#directory = path.resolve(directory);
    this.#stateFile = path.join(this.#directory, 'catalog.json');
    this.#guardFile = path.join(this.#directory, 'lifecycle.lock');
    this.#protocol = requireProtocol(protocol);
    if (!lease || typeof lease.acquire !== 'function') throw new TypeError('ledger mutation lease is required');
    this.#lease = lease;
  }

  async #ensureDirectory() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment directory must be a real directory');
  }

  async #acquire() {
    await this.#ensureDirectory();
    const held = await this.#lease.acquire({ mode: 'exclusive' });
    if (!held) throw new Error('environment lifecycle mutation is already active');
    if (typeof held.assertHeld !== 'function' || typeof held.release !== 'function') {
      await held.release?.();
      throw new TypeError('ledger mutation lease contract is incomplete');
    }
    try {
      let legacy = false;
      try { await lstat(this.#guardFile); legacy = true; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (legacy) throw new Error('legacy lifecycle guard requires migration by the quiescent authority owner');
      held.assertHeld();
      this.#held = held;
      return async () => {
        this.#held = null;
        await held.release();
      };
    } catch (error) {
      await held.release();
      throw error;
    }
  }

  assertHeld() {
    if (this.#held == null) throw new Error('ledger mutation requires an active lease');
    this.#held.assertHeld();
  }

  mutationContext() {
    this.assertHeld();
    const held = this.#held;
    return Object.freeze({ signal: held.signal, assertHeld: () => held.assertHeld() });
  }

  async snapshot(work) {
    if (typeof work !== 'function') throw new TypeError('ledger snapshot work must be a function');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.read();
      const result = await work(state);
      if ((await this.read()).revision === state.revision) return result;
    }
    throw new Error('environment state changed during observation');
  }

  run(work) {
    if (typeof work !== 'function') throw new TypeError('ledger work must be a function');
    const guarded = async () => {
      const release = await this.#acquire();
      try {
        const result = await work();
        this.assertHeld();
        return result;
      }
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
    this.assertHeld();
    state.revision = Number(state.revision ?? 0) + 1;
    const temporary = path.join(this.#directory, `.catalog-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    this.assertHeld();
    await rename(temporary, this.#stateFile);
  }
}
