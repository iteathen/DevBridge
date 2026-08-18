import process from 'node:process';
import { PolicyError } from '../errors.js';
import { discoverNativeCompiler } from './native-compiler-probe.js';
import { resolveExecutable } from './executable-resolver.js';

const NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/u;

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

  async resolve(name, { refresh = false } = {}) {
    const entry = this.#resolvers.get(name);
    if (!entry) throw new PolicyError(`unregistered local toolchain ${name}`);
    if (!refresh && this.#cache.has(name)) return structuredClone(this.#cache.get(name));
    const descriptor = await entry.resolver();
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.executable !== 'string' || descriptor.executable.length === 0) {
      throw new PolicyError(`toolchain ${name} resolver returned an invalid descriptor`);
    }
    const normalized = { name, ...entry.metadata, ...descriptor };
    this.#cache.set(name, normalized);
    return structuredClone(normalized);
  }

  async inspect() {
    const results = [];
    for (const name of this.names()) {
      try {
        const descriptor = await this.resolve(name);
        results.push({
          name,
          available: true,
          layer: descriptor.layer ?? 'core',
          family: descriptor.family ?? name,
          executable: descriptor.executable,
          linker: descriptor.linker ?? null,
          version: descriptor.version ?? null,
          source: descriptor.source ?? null,
        });
      } catch (error) {
        results.push({ name, available: false, layer: 'core', error: error.message });
      }
    }
    return results;
  }
}

export function createCoreToolchainRegistry({ env = process.env, platform = process.platform } = {}) {
  let nativePromise = null;
  const native = async () => {
    nativePromise ??= discoverNativeCompiler({ env, platform });
    const compiler = await nativePromise;
    if (!compiler) throw new PolicyError('no approved native C compiler was discovered locally');
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
