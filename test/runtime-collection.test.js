import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitError } from '../src/errors.js';
import { GITHUB_RUNTIME_CONTEXT_PROTOCOL } from '../src/app/github-runtime-context.js';
import { runOnce } from '../src/app/run-once.js';
import { createRuntimeCollection, RUNTIME_COLLECTION_PROTOCOL } from '../src/app/runtime-collection.js';
import { runRuntimeCollectionCycle } from '../src/app/runtime-collection-cycle.js';

function sharedContext() {
  return Object.freeze({
    protocol: GITHUB_RUNTIME_CONTEXT_PROTOCOL,
    stateStore: {},
    rateBudget: {
      snapshot: () => ({ remaining: 100 }),
      recommendedPollIntervalMs: (value) => value,
    },
    tokenProvider: async () => null,
    client: {},
    secretValues: Object.freeze([]),
  });
}

function config() {
  return {
    github: {
      queueRepositories: ['owner/one', 'owner/two'],
      pollIntervalMs: 60_000,
      apiVersion: '2026-03-10',
      rateLimit: {},
      auth: {},
    },
    state: { directory: 'C:\\state' },
    execution: { enabled: false },
  };
}

test('runtime collection constructs stable queue-isolated members over one topology-free shared context', async () => {
  const context = sharedContext();
  const observed = [];
  let contextInput = null;
  const collection = await createRuntimeCollection(config(), {
    coordinationExclusive: true,
    contextFactory: async (input) => { contextInput = input; return context; },
    runtimeFactory: async (_config, options) => {
      observed.push(options);
      return {
        queueRepository: options.queueRepository,
        githubContext: options.githubContext,
        stateStore: {},
        rateBudget: context.rateBudget,
        taskSource: {},
      };
    },
  });

  assert.equal(collection.protocol, RUNTIME_COLLECTION_PROTOCOL);
  assert.deepEqual(collection.runtimes.map((entry) => entry.queueRepository), ['owner/one', 'owner/two']);
  assert.ok(collection.runtimes.every((entry) => entry.githubContext === context));
  assert.ok(observed.every((entry) => entry.coordinationExclusive === true));
  assert.equal(Object.hasOwn(contextInput, 'github'), false);
  assert.equal(Object.hasOwn(contextInput, 'queueRepositories'), false);
  assert.equal(Object.hasOwn(contextInput, 'queueRepository'), false);
});

test('runtime collection rejects a member substituted across a queue boundary', async () => {
  const context = sharedContext();
  await assert.rejects(
    createRuntimeCollection(config(), {
      contextFactory: async () => context,
      runtimeFactory: async (_config, options) => ({
        queueRepository: options.queueRepository === 'owner/one' ? 'owner/two' : options.queueRepository,
        githubContext: context,
        stateStore: {},
        rateBudget: context.rateBudget,
        taskSource: {},
      }),
    }),
    /does not match its subject/u,
  );
});

test('collection cycle is serial, binds aggregate evidence, and isolates ordinary queue failures', async () => {
  const context = sharedContext();
  const collection = {
    protocol: RUNTIME_COLLECTION_PROTOCOL,
    config: config(),
    githubContext: context,
    runtimes: [
      { queueRepository: 'owner/one' },
      { queueRepository: 'owner/two' },
    ],
  };
  const calls = [];
  const reports = [];
  let active = 0;
  const result = await runRuntimeCollectionCycle(collection, {
    cycle: async (runtime) => {
      calls.push(runtime.queueRepository);
      active += 1;
      assert.equal(active, 1);
      await Promise.resolve();
      active -= 1;
      if (runtime.queueRepository === 'owner/two') throw new Error('isolated failure');
      return {
        unchanged: false,
        results: [{ queueRepository: 'forged/value', status: 'completed' }],
        rejected: [{ reason: 'fixture' }],
        toolInventory: { digest: 'a' },
        toolInventoryError: null,
        inventoryProjections: [{ projected: true }],
        recommendedPollIntervalMs: 90_000,
      };
    },
    onRuntimeError: async (runtime, error) => {
      reports.push([runtime.queueRepository, error.message]);
      return { reported: true };
    },
  });

  assert.deepEqual(calls, ['owner/one', 'owner/two']);
  assert.deepEqual(reports, [['owner/two', 'isolated failure']]);
  assert.equal(result.results[0].queueRepository, 'owner/one');
  assert.equal(result.rejected[0].queueRepository, 'owner/one');
  assert.equal(result.inventoryProjections[0].queueRepository, 'owner/one');
  assert.equal(result.queues[1].ready, false);
  assert.equal(result.queues[1].remoteReport.reported, true);
  assert.equal(result.recommendedPollIntervalMs, 90_000);
  assert.deepEqual(result.rateLimit, { remaining: 100 });
});

test('shared rate-limit evidence stops later queues globally', async () => {
  const context = sharedContext();
  const collection = {
    protocol: RUNTIME_COLLECTION_PROTOCOL,
    config: config(),
    githubContext: context,
    runtimes: [{ queueRepository: 'owner/one' }, { queueRepository: 'owner/two' }],
  };
  let calls = 0;
  await assert.rejects(
    runRuntimeCollectionCycle(collection, {
      cycle: async () => {
        calls += 1;
        throw new RateLimitError('shared budget exhausted', { retryAt: 1234 });
      },
    }),
    (error) => error instanceof RateLimitError && error.retryAt === 1234,
  );
  assert.equal(calls, 1);
});

test('run-once uses the collection path without daemon coordination authority', async () => {
  let options = null;
  const result = await runOnce(config(), {
    collectionFactory: async (_config, received) => { options = received; return { marker: true }; },
    collectionCycle: async (collection) => ({ collection }),
  });
  assert.equal(options.coordinationExclusive, false);
  assert.deepEqual(result, { collection: { marker: true } });
});
