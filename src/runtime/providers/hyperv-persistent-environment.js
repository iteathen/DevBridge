import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { HyperVPersistentEnvironment as PersistentEnvironmentCore } from './hyperv-persistent-environment-core.js';

function canonicalRoot(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError('environment source root is invalid');
  const lexical = path.resolve(value);
  const info = lstatSync(lexical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment source root must be a real directory');
  return realpathSync(lexical);
}

export class HyperVPersistentEnvironment extends PersistentEnvironmentCore {
  constructor(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('environment adapter options must be an object');
    super({ ...options, sourceRoot: canonicalRoot(options.sourceRoot) });
  }
}
