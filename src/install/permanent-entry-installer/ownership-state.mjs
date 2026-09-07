import { createExactValueState } from '../../runtime/exact-value-state.js';

export const OWNERSHIP_VALUE_PROTOCOL = 'devbridge/entry-ownership-value-v1';

export function createOwnershipState(options = {}) {
  return createExactValueState({
    ...options,
    protocol: OWNERSHIP_VALUE_PROTOCOL,
    controlIdentity: 'control',
  });
}
