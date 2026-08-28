import { JsonStateStore } from './json-state-store.js';

const KEY = 'selection:v1';

export function createWindowsInstallMediaSelectionStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('install media selection state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    load: () => store.get(KEY),
    save: (value) => store.set(KEY, value),
  });
}
