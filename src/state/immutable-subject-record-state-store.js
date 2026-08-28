import { isDeepStrictEqual } from 'node:util';
import { JsonStateStore } from './json-state-store.js';

const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const KEY_PREFIX = 'record:';

function subject(value) {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError('record subject is invalid');
  return value;
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('subject record must be an object');
  return value;
}

export function createImmutableSubjectRecordStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('subject record state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    load: (identity) => store.get(`${KEY_PREFIX}${subject(identity)}`),
    async save(identity, value) {
      const selected = subject(identity);
      const next = record(value);
      const key = `${KEY_PREFIX}${selected}`;
      const current = await store.get(key);
      if (current != null) {
        if (!isDeepStrictEqual(current, next)) throw new Error('immutable subject record does not match its existing value');
        return Object.freeze({ changed: false });
      }
      await store.set(key, next);
      return Object.freeze({ changed: true });
    },
  });
}
