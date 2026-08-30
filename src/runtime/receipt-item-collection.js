import { createConditionalItemSet } from './conditional-item-set.js';

export function createReceiptItemCollection({ journal } = {}) {
  if (!journal || typeof journal.read !== 'function' || typeof journal.compareAndAccept !== 'function') {
    throw new TypeError('receipt item journal contract is incomplete');
  }
  return createConditionalItemSet({
    records: Object.freeze({
      async read() {
        const record = await journal.read();
        return record == null
          ? Object.freeze({ revision: null, items: Object.freeze([]) })
          : Object.freeze({ revision: record.generation, items: record.items });
      },
      async compare({ revision, items }) {
        const result = await journal.compareAndAccept({ generation: revision, items });
        const record = result.record;
        return Object.freeze({
          accepted: result.accepted,
          snapshot: record == null
            ? Object.freeze({ revision: null, items: Object.freeze([]) })
            : Object.freeze({ revision: record.generation, items: record.items }),
        });
      },
    }),
  });
}
