import process from 'node:process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { PolicyError } from '../errors.js';
import { discoverNativeCompiler } from './native-compiler-probe.js';
import { resolveExecutable } from './executable-resolver.js';

const NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/u;

async function stillRunnable(descriptor) {
  try {
    await access(descriptor.executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class LocalToolchainRegistry {
  #resolvers = new Map();
  #cache = new Map();

  register(name, resolver, metadata = {}) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new PolicyError('toolchain name is invalid');
    if (this.#resolvers.has(name)) throw new PolicyError(`toolchain ${name} is already registered`);
    if (typeof resolver !== 'function') throw new PolicyError(`toolchain ${name} resolver must be a function`);
    this.#resolvers.set(name, { resolver, metadata: { layer: 'core', ...metadata } });
    return this;
  }

  has(name) { return this.#resolvers.has(name); }
  names() { return [...this.#resolvers.keys()].sort(); }
  invalidate(name = null) {
    if (name == null) this.#cache.clear();
    else this.#cache.delete(name);
  }

  async resolve(name, { refresh = false } = {}) {
    const entry = this.#resolvers.get(name);
    if (!entry) throw new PolicyError(`unregistered local toolchain ${name}`);
    if (!refresh && this.#cache.has(name)) {
      const cached = this.#cache.get(name);
      if (await stillRunnable(cached)) return structuredClone(cached);
      this.#cache.delete(name);
    }
    let descriptor;
    try {
      descriptor = await entry.resolver();
    } catch (error) {
      this.#cache.delete(name);
      throw error;
    }
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.executable !== 'string' || descriptor.executable.length === 0) {
      this.#cache.delete(name);
      throw new PolicyError(`toolchain ${name} resolver returned an invalid descriptor`);
    }
    if (!(await stillRunnable(descriptor))) {
      this.#cache.delete(name);
      throw new PolicyError(`toolchain ${name} resolved executable is no longer runnable`);
    }
    const normalized = { name, ...entry.metadata, ...descriptor };
    this.#cache.set(name, normalized);
    return structuredClone(normalized);
  }

  async inspect({ includePaths = false, refresh = false } = {}) {
    const results = [];
    for (const name of this.names()) {
      const probedAt = new Date().toISOString();
      try {
        const descriptor = await this.resolve(name, { refresh });
        const record = {
          name,
          available: true,
          health: 'healthy',
          layer: descriptor.layer ?? 'core',
          family: descriptor.family ?? name,
          version: descriptor.version ?? null,
          source: descriptor.source ?? null,
          probedAt,
        };
        if (includePaths) {
          record.executable = descriptor.executable;
          record.linker = descriptor.linker ?? null;
          record.compiler = descriptor.compiler ?? null;
        }
        results.push(record);
      } catch (error) {
        results.push({ name, available: false, health: 'unavailable', layer: 'core', version: null, source: null, probedAt, errorClass: error.name });
      }
    }
    return results;
  }
}

export function createCoreToolchainRegistry({ env = process.env, platform = process.platform } = {}) {
  let nativePromise = null;
  const native = async () => {
    nativePromise ??= discoverNativeCompiler({ env, platform });
    let compiler;
    try { compiler = await nativePromise; }
    catch (error) { nativePromise = null; throw error; }
    if (!compiler) {
      nativePromise = null;
      throw new PolicyError('no approved native C compiler was discovered locally');
    }
    return compiler;
  };

  return new LocalToolchainRegistry()
    .register('node', async () => ({
      family: 'node',
      executable: process.execPath,
      version: process.version,
      source: 'current-runtime',
    }))
    .register('cmake', async () => ({
      family: 'cmake',
      executable: await resolveExecutable('cmake', env),
      version: null,
      source: 'PATH',
    }))
    .register('ctest', async () => ({
      family: 'ctest',
      executable: await resolveExecutable('ctest', env),
      version: null,
      source: 'PATH',
    }))
    .register('native.c', async () => {
      const compiler = await native();
      return {
        family: compiler.family,
        executable: compiler.executable,
        linker: compiler.linker ?? null,
        version: compiler.version ?? null,
        source: compiler.source ?? 'local-discovery',
      };
    })
    .register('native.linker', async () => {
      const compiler = await native();
      return {
        family: compiler.linker ? `${compiler.family}-linker` : `${compiler.family}-driver-linker`,
        executable: compiler.linker ?? compiler.executable,
        compiler: compiler.executable,
        version: compiler.version ?? null,
        source: compiler.source ?? 'local-discovery',
      };
    });
}
