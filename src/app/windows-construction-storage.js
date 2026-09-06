import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { JsonStateStore } from '../state/json-state-store.js';

const PROTOCOL = 'devbridge/windows-construction-storage-v1';

function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')
      || value.startsWith('\\\\') || path.resolve(value).startsWith('\\\\')
      || path.resolve(value) === path.parse(path.resolve(value)).root) {
    throw new TypeError('Windows construction storage must be an absolute local directory below a volume root');
  }
  return path.resolve(value);
}

async function realDirectories(location, { missing = false } = {}) {
  for (let current = location; ; current = path.dirname(current)) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Windows construction storage must use real directories');
    } catch (error) {
      if (!missing || error?.code !== 'ENOENT') throw error;
    }
    if (path.dirname(current) === current) return;
  }
}

export async function reconcileWindowsConstructionStorage({ stateDirectory, location = null } = {}) {
  const state = directory(stateDirectory);
  const store = new JsonStateStore(path.join(state, 'windows-construction-storage.json'));
  const saved = await store.get('storage:v1');
  if (saved != null && (saved.protocol !== PROTOCOL || Object.keys(saved).sort().join(',') !== 'directory,protocol')) {
    throw new Error('Windows construction storage setting is invalid');
  }
  const accepted = saved == null ? null : directory(saved.directory);
  const selected = location == null ? accepted : directory(location);
  const same = accepted != null && (process.platform === 'win32' ? selected.toLowerCase() === accepted.toLowerCase() : selected === accepted);
  if (accepted != null && !same) throw new Error('Relocating existing Windows construction storage is not supported');
  if (selected == null) return null;
  if (accepted != null) {
    await realDirectories(accepted);
    return accepted;
  }
  for (const name of ['preparation.json', 'journal.json', path.join('construction', 'state.json')]) {
    try {
      await lstat(path.join(state, 'windows-production-image-canary', name));
      throw new Error('Select Windows construction storage before construction starts');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  await realDirectories(selected, { missing: true });
  try {
    if ((await readdir(selected)).length !== 0) throw new Error('Select an empty directory for Windows construction storage');
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await mkdir(selected, { recursive: true, mode: 0o700 });
  await realDirectories(selected);
  await store.set('storage:v1', { protocol: PROTOCOL, directory: selected });
  return selected;
}
