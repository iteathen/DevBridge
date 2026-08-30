import { createReceiptValueSource } from '../../runtime/receipt-value-source.js';

export function createOwnershipInventorySource({ include, ...options } = {}) {
  return createReceiptValueSource({
    ...options,
    select: include,
  });
}
