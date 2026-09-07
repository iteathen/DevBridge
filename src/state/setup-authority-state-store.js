import path from 'node:path';
import { createExclusiveMutation } from './exclusive-mutation.js';
import { createJsonRecordFile } from './json-record-file.js';

const RECORD_KEY = 'setup:authority';

export function createSetupAuthorityStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('setup authority state file is required');
  const target = path.resolve(filePath);
  const file = createJsonRecordFile(target);
  const exclusively = createExclusiveMutation();
  return Object.freeze({
    async load() {
      const document = await file.read();
      return structuredClone(document[RECORD_KEY]);
    },
    async mutate(transform) {
      if (typeof transform !== 'function') throw new TypeError('setup authority state transform is required');
      return exclusively(target, async () => {
        const document = await file.read();
        const outcome = await transform(structuredClone(document[RECORD_KEY]));
        if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
          throw new TypeError('setup authority state transform outcome is invalid');
        }
        const keys = Object.keys(outcome);
        if (!Object.hasOwn(outcome, 'result') || keys.some((key) => !['next', 'result'].includes(key))) {
          throw new TypeError('setup authority state transform outcome is invalid');
        }
        if (!Object.hasOwn(outcome, 'next')) return outcome.result;
        if (outcome.next === undefined) throw new TypeError('setup authority state next value is invalid');
        const next = structuredClone(outcome.next);
        await file.replace({ ...document, [RECORD_KEY]: next });
        return outcome.result;
      });
    },
  });
}
