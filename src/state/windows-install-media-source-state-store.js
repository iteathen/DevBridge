import { JsonStateStore } from './json-state-store.js';

const KEY_PREFIX = 'source:';

export function createWindowsInstallMediaSourceStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('install media source state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    load: (reference) => store.get(`${KEY_PREFIX}${reference}`),
    save: (reference, value) => store.set(`${KEY_PREFIX}${reference}`, value),
    async list() {
      const entries = await store.entries(KEY_PREFIX);
      return entries.map(([key, value]) => Object.freeze({ reference: key.slice(KEY_PREFIX.length), value }));
    },
  });
}
