import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const REFERENCE = /^source-[a-f0-9]{32}$/u;
const MAX_ROOTS = 16;
const MAX_LOCATIONS = 16;
const MAX_CANDIDATES = 16;

function absoluteValues(raw, maximum, name) {
  if (!Array.isArray(raw) || raw.length > maximum) throw new TypeError(`${name} are invalid`);
  return Object.freeze(raw.map((value, index) => {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) throw new TypeError(`${name}[${index}] is invalid`);
    return path.resolve(value);
  }));
}

function requireReference(value) {
  if (typeof value !== 'string' || !REFERENCE.test(value)) throw new TypeError('install media source reference is invalid');
  return value;
}

function sourceReference(location, platform) {
  const identity = platform === 'win32' ? location.toLowerCase() : location;
  return `source-${createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32)}`;
}

function sourceRegistry(value) {
  if (!value || ['load', 'save', 'list'].some((name) => typeof value[name] !== 'function')) throw new TypeError('install media source registry contract is incomplete');
  return value;
}

function storedSource(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'location')) {
    throw new Error('stored install media source is invalid');
  }
  if (typeof value.location !== 'string' || !path.isAbsolute(value.location)) throw new Error('stored install media source is invalid');
  return Object.freeze({ location: path.resolve(value.location) });
}

async function exactIso(location) {
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink() || path.extname(location).toLowerCase() !== '.iso') throw new Error('install media source must be a real ISO file');
  const actual = await realpath(location);
  const actualInfo = await lstat(actual);
  if (!actualInfo.isFile() || actualInfo.isSymbolicLink() || path.extname(actual).toLowerCase() !== '.iso') throw new Error('install media source must resolve to a real ISO file');
  return Object.freeze({ location: actual, bytes: actualInfo.size });
}

export class WindowsInstallMediaSource {
  #roots;
  #locations;
  #registry;
  #platform;
  #invoke;
  #inspectorFactory;

  constructor({ roots = [], locations = [], registry, platform = process.platform, invoke, inspectorFactory } = {}) {
    this.#roots = absoluteValues(roots, MAX_ROOTS, 'install media source roots');
    this.#locations = absoluteValues(locations, MAX_LOCATIONS, 'install media source locations');
    this.#registry = sourceRegistry(registry);
    if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('install media source platform is invalid');
    if (typeof invoke !== 'function' || typeof inspectorFactory !== 'function') throw new TypeError('install media source dependencies are invalid');
    this.#platform = platform;
    this.#invoke = invoke;
    this.#inspectorFactory = inspectorFactory;
  }

  async #current() {
    if (this.#platform !== 'win32') throw new Error('Windows install media discovery requires a Windows host');
    const locations = [...this.#locations];
    for (const rootLocation of this.#roots) {
      let root;
      try {
        const info = await lstat(rootLocation);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('install media discovery root must be a real directory');
        root = await realpath(rootLocation);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.iso') locations.push(path.join(root, entry.name));
      }
    }
    for (const entry of await this.#registry.list()) {
      requireReference(entry?.reference);
      locations.push(storedSource(entry.value).location);
    }

    const selected = new Map();
    for (const location of locations) {
      let exact;
      try { exact = await exactIso(location); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      const key = this.#platform === 'win32' ? exact.location.toLowerCase() : exact.location;
      selected.set(key, exact);
      if (selected.size > MAX_CANDIDATES) throw new Error('install media discovery exceeded its candidate bound; select one exact source location');
    }

    const result = [];
    for (const exact of [...selected.values()].sort((left, right) => left.location.localeCompare(right.location))) {
      const reference = sourceReference(exact.location, this.#platform);
      const existing = storedSource(await this.#registry.load(reference));
      const existingLocation = existing?.location ?? null;
      if (existingLocation != null && (this.#platform === 'win32' ? existingLocation.toLowerCase() !== exact.location.toLowerCase() : existingLocation !== exact.location)) {
        throw new Error('stored install media source identity changed');
      }
      if (existing == null) await this.#registry.save(reference, Object.freeze({ location: exact.location }));
      result.push(Object.freeze({ reference, name: path.basename(exact.location), bytes: exact.bytes }));
    }
    return Object.freeze(result);
  }

  async list() { return this.#current(); }

  async #selected(rawReference) {
    if (this.#platform !== 'win32') throw new Error('Windows install media discovery requires a Windows host');
    const reference = requireReference(rawReference);
    const stored = storedSource(await this.#registry.load(reference));
    if (stored == null) throw new Error('install media source is unavailable');
    const exact = await exactIso(stored.location);
    if (sourceReference(exact.location, this.#platform) !== reference) throw new Error('install media source identity changed');
    return Object.freeze({ reference, name: path.basename(exact.location), bytes: exact.bytes, location: exact.location });
  }

  async inventory(reference) {
    const selected = await this.#selected(reference);
    const inspector = this.#inspectorFactory({ sourceRoot: path.dirname(selected.location), platform: this.#platform, invoke: this.#invoke });
    if (!inspector || typeof inspector.inventory !== 'function') throw new TypeError('install media inventory contract is incomplete');
    return inspector.inventory({ location: selected.location });
  }

  async resolve(reference) {
    const selected = await this.#selected(reference);
    return Object.freeze({ location: selected.location, name: selected.name, bytes: selected.bytes });
  }
}

export function createWindowsInstallMediaSource(options) {
  return new WindowsInstallMediaSource(options);
}
