import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';
import { normalizePlanPath } from '../run/controller-plan.js';

const MAX_ARGS = 64;
const MAX_ARG_BYTES = 4096;
const WINDOWS_ENV = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR'];
const POSIX_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP'];

function objectParams(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PolicyError(`${operation} params must be an object`);
  return value;
}

function onlyKeys(value, allowed, operation) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new PolicyError(`${operation} parameter ${key} is not allowed`);
}

function stringArgs(value, operation) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS || value.some((entry) => typeof entry !== 'string' || Buffer.byteLength(entry, 'utf8') > MAX_ARG_BYTES || entry.includes('\0'))) {
    throw new PolicyError(`${operation} arguments must be a bounded string array`);
  }
  return [...value];
}

function projectPath(projectDir, relative, name) {
  const safe = normalizePlanPath(relative, name);
  const resolved = path.resolve(projectDir, safe);
  const rel = path.relative(path.resolve(projectDir), resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new PolicyError(`${name} escaped project root`);
  return { safe, resolved };
}

function localEnvironment() {
  return { pass: process.platform === 'win32' ? WINDOWS_ENV : POSIX_ENV, set: {} };
}

export class DeterministicOperationRegistry {
  #operations = new Map();

  register(name, adapter) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/u.test(name)) throw new PolicyError('registered operation name is invalid');
    if (this.#operations.has(name)) throw new PolicyError(`registered operation ${name} already exists`);
    if (!adapter || typeof adapter.validate !== 'function' || typeof adapter.execute !== 'function') {
      throw new PolicyError(`registered operation ${name} must provide validate and execute`);
    }
    this.#operations.set(name, adapter);
    return this;
  }

  has(name) { return this.#operations.has(name); }
  names() { return [...this.#operations.keys()].sort(); }

  validate(name, params) {
    const adapter = this.#operations.get(name);
    if (!adapter) throw new PolicyError(`controller plan references unregistered operation ${name}`);
    return adapter.validate(params);
  }

  async execute(name, params, context) {
    const adapter = this.#operations.get(name);
    if (!adapter) throw new PolicyError(`controller plan references unregistered operation ${name}`);
    const validated = adapter.validate(params);
    return adapter.execute(validated, context);
  }
}

function nodeScriptAdapter({ mode }) {
  return {
    validate(raw) {
      const params = objectParams(raw, mode);
      const allowed = mode === 'node.run' ? new Set(['path', 'arguments']) : mode === 'node.test' ? new Set(['paths']) : new Set(['path']);
      onlyKeys(params, allowed, mode);
      if (mode === 'node.test') {
        if (!Array.isArray(params.paths) || params.paths.length === 0 || params.paths.length > 32) throw new PolicyError('node.test paths must contain 1-32 project-relative paths');
        return { paths: params.paths.map((value, index) => normalizePlanPath(value, `node.test.paths[${index}]`)) };
      }
      const script = normalizePlanPath(params.path, `${mode}.path`);
      return { path: script, arguments: mode === 'node.run' ? stringArgs(params.arguments, mode) : [] };
    },
    async execute(params, { projectDir, processRunner, onActivity }) {
      if (mode === 'node.test') {
        for (const relative of params.paths) await access(projectPath(projectDir, relative, 'node.test path').resolved);
        return processRunner.run({
          executable: process.execPath,
          args: ['--test', ...params.paths],
          cwd: projectDir,
          timeoutMs: 180_000,
          maxOutputBytes: 1024 * 1024,
          environment: localEnvironment(),
          onActivity
        });
      }
      await access(projectPath(projectDir, params.path, `${mode} path`).resolved);
      const args = mode === 'node.syntax-check' ? ['--check', params.path] : [params.path, ...params.arguments];
      return processRunner.run({
        executable: process.execPath,
        args,
        cwd: projectDir,
        timeoutMs: mode === 'node.run' ? 120_000 : 60_000,
        maxOutputBytes: 1024 * 1024,
        environment: localEnvironment(),
        onActivity
      });
    }
  };
}

export function createCoreOperationRegistry() {
  return new DeterministicOperationRegistry()
    .register('node.syntax-check', nodeScriptAdapter({ mode: 'node.syntax-check' }))
    .register('node.test', nodeScriptAdapter({ mode: 'node.test' }))
    .register('node.run', nodeScriptAdapter({ mode: 'node.run' }));
}
