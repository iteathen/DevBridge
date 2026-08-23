import { JsonStateStore } from './json-state-store.js';

const RECORD_KEY = 'setup:authority';

export function createSetupAuthorityStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('setup authority state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    load: () => store.get(RECORD_KEY),
    save: (value) => store.set(RECORD_KEY, value),
  });
}
