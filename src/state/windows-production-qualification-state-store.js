import { JsonStateStore } from './json-state-store.js';

const KEY_PREFIX = 'windows-production-qualification:';

export function createWindowsProductionQualificationStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('production qualification state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    load: (identity) => store.get(`${KEY_PREFIX}${identity}`),
    save: (identity, value) => store.set(`${KEY_PREFIX}${identity}`, value),
  });
}
