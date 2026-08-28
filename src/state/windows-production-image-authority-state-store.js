import { JsonStateStore } from './json-state-store.js';

const KEY_PREFIX = 'windows-production-image-authority:';

export function createWindowsProductionImageAuthorityStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('production image authority state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    load: (subjectRef) => store.get(`${KEY_PREFIX}${subjectRef}`),
    save: (subjectRef, value) => store.set(`${KEY_PREFIX}${subjectRef}`, value),
  });
}
