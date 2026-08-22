import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { normalizeProjectRelativePath, ProjectRelativePathError } from '../values/project-relative-path.js';

const SAFE_ID = /^[A-Za-z0-9_.-]{1,80}$/u;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_SUBJECT_BYTES = 512;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new PolicyError(`${name} must be a safe local input identifier`);
  return value;
}

function safeDestination(value) {
  try {
    return normalizeProjectRelativePath(value);
  } catch (error) {
    if (!(error instanceof ProjectRelativePathError)) throw error;
    throw new PolicyError(`controller input destination ${error.message}`, { cause: error });
  }
}

function safeSubject(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_SUBJECT_BYTES) {
    throw new PolicyError('controller input subject is invalid');
  }
  if (/[^\x20-\x7e]/u.test(value)) throw new PolicyError('controller input subject contains control or non-ASCII data');
  return value;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function ensureParentNoFollow(root, relative, effectGuard) {
  const rootPath = path.resolve(root);
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new PolicyError('controller input project root must be a real directory');
  const rootReal = await realpath(rootPath);
  const target = path.resolve(rootPath, relative);
  if (!isWithin(rootPath, target)) throw new PolicyError('controller input destination escaped project root');
  const segments = path.relative(rootPath, path.dirname(target)).split(path.sep).filter(Boolean);
  let cursor = rootPath;
  for (const segment of segments) {
    const next = path.join(cursor, segment);
    if (!(await exists(next))) {
      await effectGuard();
      try { await mkdir(next, { mode: 0o700 }); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    const info = await lstat(next);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new PolicyError(`controller input destination crosses filesystem indirection: ${relative}`);
    cursor = await realpath(next);
    if (!isWithin(rootReal, cursor)) throw new PolicyError(`controller input destination resolves outside project root: ${relative}`);
  }
  return target;
}

async function writeExactInput(root, relative, bytes, effectGuard) {
  const target = await ensureParentNoFollow(root, relative, effectGuard);
  if (await exists(target)) {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new PolicyError(`controller input destination is not a regular file: ${relative}`);
    const current = await readFile(target);
    if (digest(current) !== digest(bytes)) throw new PolicyError(`controller input destination already exists with different content: ${relative}`);
    return { reconciled: true };
  }

  const temporary = `${target}.devbridge-${process.pid}-${randomUUID()}.tmp`;
  await effectGuard();
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await effectGuard();
    if (await exists(target)) throw new PolicyError(`controller input destination appeared during materialization: ${relative}`);
    await rename(temporary, target);
    await effectGuard();
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || digest(await readFile(target)) !== digest(bytes)) {
      throw new PolicyError(`controller input destination failed exact readback: ${relative}`);
    }
    return { reconciled: false };
  } finally {
    await rm(temporary, { force: true });
  }
}

export class ControllerInputRegistry {
  #entries = new Map();
  #effectGuard;

  constructor({ effectGuard = async () => {} } = {}) {
    if (typeof effectGuard !== 'function') throw new TypeError('ControllerInputRegistry effectGuard must be a function');
    this.#effectGuard = effectGuard;
  }

  register(name, source) {
    const id = safeId(name, 'controller input name');
    if (this.#entries.has(id)) throw new PolicyError(`controller input ${id} is already registered`);
    if (!source || typeof source !== 'object' || typeof source.load !== 'function') throw new PolicyError(`controller input ${id} must provide load`);
    const destination = safeDestination(source.destination);
    this.#entries.set(id, Object.freeze({ destination, load: source.load }));
    return this;
  }

  has(name) {
    return typeof name === 'string' && this.#entries.has(name);
  }

  names() {
    return [...this.#entries.keys()].sort();
  }

  validate(name) {
    const id = safeId(name, 'controller input name');
    if (!this.#entries.has(id)) throw new PolicyError(`controller input ${id} is not locally registered`);
    return id;
  }

  destination(name) {
    const id = this.validate(name);
    return this.#entries.get(id).destination;
  }

  async materialize(name, { projectDir, scratch } = {}) {
    const id = this.validate(name);
    if (typeof projectDir !== 'string' || projectDir.length === 0) throw new PolicyError('controller input project directory is required');
    if (!scratch || typeof scratch.directory !== 'function') throw new PolicyError('controller input managed scratch is required');
    const entry = this.#entries.get(id);
    await this.#effectGuard();
    const loaded = await entry.load({ projectDir, scratch, name: id });
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new PolicyError(`controller input ${id} returned an invalid value`);
    const keys = Object.keys(loaded);
    if (keys.some((key) => !['bytes', 'subject'].includes(key))) throw new PolicyError(`controller input ${id} returned an unsupported field`);
    const bytes = Buffer.isBuffer(loaded.bytes) ? loaded.bytes : loaded.bytes instanceof Uint8Array ? Buffer.from(loaded.bytes) : null;
    if (!bytes || bytes.length > MAX_INPUT_BYTES) throw new PolicyError(`controller input ${id} exceeds the bounded byte limit`);
    const subject = safeSubject(loaded.subject);
    const sha256 = digest(bytes);
    await this.#effectGuard();
    const applied = await writeExactInput(projectDir, entry.destination, bytes, this.#effectGuard);
    return Object.freeze({ name: id, subject, sha256, bytes: bytes.length, destination: entry.destination, reconciled: applied.reconciled });
  }
}
