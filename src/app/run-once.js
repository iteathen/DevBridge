import { createRuntimeCollection } from './runtime-collection.js';
import { runRuntimeCollectionCycle } from './runtime-collection-cycle.js';

export async function runOnce(config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  collectionFactory = createRuntimeCollection,
  collectionCycle = runRuntimeCollectionCycle,
} = {}) {
  const collection = await collectionFactory(config, { env, fetchImpl, coordinationExclusive: false });
  return collectionCycle(collection);
}
