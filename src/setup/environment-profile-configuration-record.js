import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_MAX_BYTES,
  normalizeEnvironmentProfileConfigurationRecord,
} from '../runtime/environment-profile-configuration.js';
import { ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY } from '../state/environment-profile-configuration-state-store.js';

const MAX_STATE_BYTES = ENVIRONMENT_PROFILE_CONFIGURATION_MAX_BYTES + 64 * 1024;

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function readEnvironmentProfileConfigurationRecord({ stateDirectory } = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || stateDirectory.includes('\0')) {
    throw new TypeError('environment profile configuration state directory is invalid');
  }
  const root = path.resolve(stateDirectory);
  const directory = path.join(root, 'environment-profile-configuration');
  const file = path.join(directory, 'state.json');
  let values;
  try { values = await Promise.all([lstat(root), lstat(directory), lstat(file)]); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!values[0].isDirectory() || values[0].isSymbolicLink()
      || !values[1].isDirectory() || values[1].isSymbolicLink()
      || !values[2].isFile() || values[2].isSymbolicLink()
      || values[2].size < 2 || values[2].size > MAX_STATE_BYTES) {
    throw new Error('accepted environment profile configuration is not one bounded real file');
  }
  const [canonicalRoot, canonicalDirectory, canonicalFile] = await Promise.all([realpath(root), realpath(directory), realpath(file)]);
  if (!inside(canonicalRoot, canonicalDirectory) || !inside(canonicalRoot, canonicalFile) || path.dirname(canonicalFile) !== canonicalDirectory) {
    throw new Error('accepted environment profile configuration escaped its state boundary');
  }
  const document = JSON.parse(await readFile(canonicalFile, 'utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('accepted environment profile configuration state is invalid');
  const raw = document[ENVIRONMENT_PROFILE_CONFIGURATION_STATE_KEY];
  return raw == null ? null : normalizeEnvironmentProfileConfigurationRecord(raw);
}
