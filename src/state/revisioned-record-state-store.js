import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { createExclusiveMutation } from './exclusive-mutation.js';
import { createJsonRecordFile } from './json-record-file.js';

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const KEY_PREFIX = 'record:';

function subject(value) {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError('record subject is invalid');
  return value;
}

function record(value, name = 'record value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  let clone;
  try {
    clone = structuredClone(value);
    const encoded = JSON.stringify(clone);
    if (encoded == null || !isDeepStrictEqual(JSON.parse(encoded), clone)) throw new TypeError(`${name} must be exact JSON data`);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(name)) throw error;
    throw new TypeError(`${name} must be exact JSON data`, { cause: error });
  }
  if (!Number.isSafeInteger(clone.revision) || clone.revision < 1) throw new TypeError(`${name}.revision is invalid`);
  return clone;
}

function selected(document, key) {
  return Object.hasOwn(document, key) ? record(document[key], 'stored record') : undefined;
}

export function createRevisionedRecordStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('record state file is required');
  const target = path.resolve(filePath);
  const file = createJsonRecordFile(target);
  const exclusively = createExclusiveMutation();

  return Object.freeze({
    async run(rawSubject, operation) {
      const identity = subject(rawSubject);
      if (typeof operation !== 'function') throw new TypeError('record operation is required');
      const key = `${KEY_PREFIX}${identity}`;
      return exclusively(target, async () => operation(Object.freeze({
        async load() {
          return structuredClone(selected(await file.read(), key));
        },
        async save(value) {
          const next = record(value);
          const document = await file.read();
          const current = selected(document, key);
          if (current?.revision === next.revision) {
            if (!isDeepStrictEqual(current, next)) throw new Error('record revision conflicts with its accepted value');
            return Object.freeze({ changed: false, revision: next.revision });
          }
          const expected = (current?.revision ?? 0) + 1;
          if (next.revision !== expected) throw new Error('record revision changed; re-read before replacing');
          await file.replace({ ...document, [key]: next });
          const accepted = selected(await file.read(), key);
          if (!isDeepStrictEqual(accepted, next)) throw new Error('record replacement did not re-observe its accepted value');
          return Object.freeze({ changed: true, revision: next.revision });
        },
      })));
    },
  });
}
