import { JsonStateStore } from './json-state-store.js';

function prefixedPort(store, prefix) {
  return Object.freeze({
    load: (identity) => store.get(`${prefix}:${identity}`),
    async save(identity, value) {
      if (prefix === 'journal') {
        const previous = await store.get(`${prefix}:${identity}`);
        if (previous && previous.operationId !== value.operationId) {
          if (previous.entries?.at(-1)?.stage !== 'terminal') throw new Error('cannot replace an active lifecycle journal');
          const historyKey = `journal-history:${previous.operationId}`;
          const archived = await store.get(historyKey);
          if (archived && JSON.stringify(archived) !== JSON.stringify(previous)) throw new Error('lifecycle journal history identity changed');
          if (!archived) await store.set(historyKey, previous);
        }
      }
      return store.set(`${prefix}:${identity}`, value);
    },
    async scan() {
      return (await store.entries(`${prefix}:`)).map(([, value]) => value);
    },
  });
}

export function createEnvironmentLifecycleStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('environment lifecycle state file is required');
  const store = new JsonStateStore(filePath);
  return Object.freeze({
    declarations: prefixedPort(store, 'declaration'),
    journal: prefixedPort(store, 'journal'),
  });
}
