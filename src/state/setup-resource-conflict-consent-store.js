import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSetupResourceConflictConsent } from '../setup/resource-conflict.js';

const MAX_BYTES = 2048;
const DIRECTORY = 'setup-resource-conflict';
const FILE = 'consent.json';

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function createSetupResourceConflictConsentStore({ stateDirectory } = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('setup resource conflict consent stateDirectory is required');
  const root = path.resolve(stateDirectory);
  const directory = path.join(root, DIRECTORY);
  const file = path.join(directory, FILE);

  async function load() {
    let values;
    try { values = await Promise.all([lstat(root), lstat(directory), lstat(file)]); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (!values[0].isDirectory() || values[0].isSymbolicLink()
        || !values[1].isDirectory() || values[1].isSymbolicLink()
        || !values[2].isFile() || values[2].isSymbolicLink()
        || values[2].size < 2 || values[2].size > MAX_BYTES) {
      throw new Error('setup resource conflict consent is not one bounded real file');
    }
    const [canonicalRoot, canonicalDirectory, canonicalFile] = await Promise.all([realpath(root), realpath(directory), realpath(file)]);
    if (!inside(canonicalRoot, canonicalDirectory) || !inside(canonicalRoot, canonicalFile)
        || path.dirname(canonicalFile) !== canonicalDirectory) {
      throw new Error('setup resource conflict consent escaped its state boundary');
    }
    return normalizeSetupResourceConflictConsent(JSON.parse(await readFile(canonicalFile, 'utf8')));
  }

  async function save(raw) {
    const consent = normalizeSetupResourceConflictConsent(raw);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const [rootInfo, directoryInfo] = await Promise.all([lstat(root), lstat(directory)]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error('setup resource conflict consent directory is invalid');
    }
    try {
      const current = await lstat(file);
      if (!current.isFile() || current.isSymbolicLink()) throw new Error('setup resource conflict consent target is invalid');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(directory, `.consent-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(consent)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    return consent;
  }

  async function clear() {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('setup resource conflict consent target is invalid');
      await rm(file, { force: false });
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  return Object.freeze({ load, save, clear });
}
