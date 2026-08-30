import os from 'node:os';
import path from 'node:path';
import { createExactArtifactReceiptJournal, EXACT_ARTIFACT_RECEIPT_PROTOCOL } from '../runtime/exact-artifact-receipt.js';
import { EXACT_ARTIFACT_SET_PROTOCOL } from '../runtime/exact-artifact-set.js';
import { createExactActionRouter } from '../runtime/exact-action-router.js';
import { EXACT_DIRECTORY_PROTOCOL } from '../runtime/exact-directory.js';
import { createExactValueInventory } from '../runtime/exact-value-inventory.js';
import { createReceiptValueSource } from '../runtime/receipt-value-source.js';
import { createReceiptItemCollection } from '../runtime/receipt-item-collection.js';
import { createRevisionedRecordStateStore } from '../state/revisioned-record-state-store.js';
import { createRunnerCacheComposition } from './runner-cache-composition.mjs';
import {
  createRunnerCacheInventorySource,
  runnerCacheIdentitySelected,
  runnerCacheRelationships,
} from './runner-cache-inventory-source.mjs';
import {
  runnerCacheOwnershipPaths,
  RUNNER_CACHE_OWNERSHIP_VALUE_PROTOCOL,
} from './runner-cache-ownership.mjs';

export const RUNNER_CACHE_INVENTORY_IDENTITY = 'entry-cache-payload';

export function createRunnerCacheInventory({ home = null } = {}, {
  compositionFactory = createRunnerCacheComposition,
  journalFactory = createExactArtifactReceiptJournal,
  recordStoreFactory = createRevisionedRecordStateStore,
  valueSourceFactory = createReceiptValueSource,
  topologySourceFactory = createRunnerCacheInventorySource,
  routerFactory = createExactActionRouter,
} = {}) {
  const selectedHome = path.resolve(String(home ?? path.join(os.homedir(), '.devbridge')));
  const cacheRoot = path.join(selectedHome, 'entry', 'cache');
  const stateRoot = path.join(selectedHome, 'entry', 'state');
  const cache = compositionFactory({ cacheRoot, stateRoot });
  const receiptPaths = runnerCacheOwnershipPaths(stateRoot);
  const journal = journalFactory({ directory: receiptPaths.receipts, scratch: receiptPaths.scratch });
  const receiptSource = valueSourceFactory({
    identity: RUNNER_CACHE_INVENTORY_IDENTITY,
    collection: createReceiptItemCollection({ journal }),
    collectionProtocol: EXACT_ARTIFACT_RECEIPT_PROTOCOL,
    valueProtocol: RUNNER_CACHE_OWNERSHIP_VALUE_PROTOCOL,
    controlIdentity: 'control',
    select: runnerCacheIdentitySelected,
    relate: runnerCacheRelationships,
  });
  const source = topologySourceFactory({
    identity: RUNNER_CACHE_INVENTORY_IDENTITY,
    source: receiptSource,
    cacheRoot,
    inspectReparse: cache.inspectReparse,
  });
  const activity = Object.freeze({
    async observe({ identity }) {
      if (identity !== RUNNER_CACHE_INVENTORY_IDENTITY) throw new TypeError('runner-cache inventory activity identity changed');
      const observed = cache.ownership.observe();
      if (!observed || typeof observed.active !== 'boolean') throw new TypeError('runner-cache inventory activity observation is invalid');
      return Object.freeze({ identity, active: observed.active });
    },
    async run({ identity }, operation) {
      if (identity !== RUNNER_CACHE_INVENTORY_IDENTITY) throw new TypeError('runner-cache inventory activity identity changed');
      if (typeof operation !== 'function') throw new TypeError('runner-cache inventory activity operation must be a function');
      return cache.ownership.duringActivity(operation);
    },
  });
  const actions = routerFactory({ actions: [
    { protocol: EXACT_ARTIFACT_SET_PROTOCOL, action: cache.artifacts },
    { protocol: EXACT_DIRECTORY_PROTOCOL, action: cache.directories },
  ] });
  const records = recordStoreFactory(path.join(stateRoot, 'cache-ownership-bindings.json'));
  return createExactValueInventory({
    identity: RUNNER_CACHE_INVENTORY_IDENTITY,
    scope: 'payload',
    coverage: ['application'],
    source,
    activity,
    records,
    actions,
  });
}
