import { bindInvocationToLease } from '../lease-bound-invocation.js';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  preflightExecutionProfileMemory,
  preflightExecutionProfileStoragePaths,
} from '../profile-resource-preflight.js';
import { LibvirtPersistentEnvironment as PersistentEnvironmentCore } from './libvirt-persistent-environment-core.js';

async function canonicalRoot(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError('environment source root is invalid');
  const lexical = path.resolve(value);
  let info;
  try { info = await lstat(lexical); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('environment source root is unavailable');
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment source root must be a real directory');
  return realpath(lexical);
}

function storageState(observation) {
  if (observation?.storage != null && observation?.compatible === true) return 'present';
  const reason = String(observation?.reason ?? '').toLowerCase();
  if (reason.includes('storage lineage is incomplete')) return 'invalid';
  if (reason.includes('storage lineage shape')
      || reason.includes('source filesystem identity')
      || reason.includes('writable filesystem identity')
      || reason.includes('storage backing')
      || reason.includes('storage inspection failed')) return 'invalid';
  if (reason.includes('storage attachment') || observation?.storage != null) return 'present';
  return 'unknown';
}

function observed(value) {
  return Object.freeze({ ...value, storageState: storageState(value) });
}

export class LibvirtPersistentEnvironment {
  #options;
  #delegate = null;

  constructor(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('environment adapter options must be an object');
    new PersistentEnvironmentCore(options);
    this.#options = { ...options };
  }

  async inspect() {
    return new PersistentEnvironmentCore(this.#options).inspect();
  }

  async #core(context = null) {
    if (context != null) {
      context.assertHeld();
      const sourceRoot = await canonicalRoot(this.#options.sourceRoot);
      return new PersistentEnvironmentCore({ ...this.#options, sourceRoot, invoke: bindInvocationToLease(this.#options.invoke, context) });
    }
    if (!this.#delegate) {
      const sourceRoot = await canonicalRoot(this.#options.sourceRoot);
      this.#delegate = new PersistentEnvironmentCore({ ...this.#options, sourceRoot });
    }
    return this.#delegate;
  }

  async provision(input, context = null) {
    preflightExecutionProfileMemory(input?.settings);
    await preflightExecutionProfileStoragePaths({
      directory: this.#options.directory,
      sourceLocation: input?.source?.handle?.location,
    });
    return observed(await (await this.#core(context)).provision(input));
  }
  async observe(identity) { return observed(await (await this.#core()).observe(identity)); }
  async start(identity, context = null) { return observed(await (await this.#core(context)).start(identity)); }
  async stop(identity, options, context = null) { return observed(await (await this.#core(context)).stop(identity, options)); }
  async drop(identity, context = null) { return (await this.#core(context)).drop(identity); }
}