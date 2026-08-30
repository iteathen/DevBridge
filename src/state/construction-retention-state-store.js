import { JsonStateStore } from './json-state-store.js';

const KEY_PREFIX = 'retention:';

export function createConstructionRetentionStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('retention state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    load: (identity) => store.get(`${KEY_PREFIX}${identity}`),
    save: (identity, value) => store.set(`${KEY_PREFIX}${identity}`, value),
    async list() {
      const entries = await store.entries(KEY_PREFIX);
      return entries.map(([key, value]) => Object.freeze({ identity: key.slice(KEY_PREFIX.length), value }));
    },
  });
}
