import { JsonStateStore } from './json-state-store.js';

const KEY_PREFIX = 'authority:';

export function createUbuntuConstructionAuthorityStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('construction authority state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    load: (subjectRef) => store.get(`${KEY_PREFIX}${subjectRef}`),
    save: (subjectRef, value) => store.set(`${KEY_PREFIX}${subjectRef}`, value),
    async list() {
      const entries = await store.entries(KEY_PREFIX);
      return entries.map(([key, value]) => Object.freeze({ subjectRef: key.slice(KEY_PREFIX.length), value }));
    },
  });
}
