import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitError } from '../src/errors.js';
import { createRuntimeSet } from '../src/app/runtime-set.js';
import { runRuntimeSetCycle } from '../src/app/run-once.js';

function config() {
  return {
    github: {
      queueRepositories: ['iteathen/DevBridge', 'iteathen/UCI_Arena'],
      repositoryDiscovery: { enabled: false, affiliations: [], maxRepositories: 30 },
      pollIntervalMs: 15_000,
    },
    workspace: { allowedOwners: ['iteathen'] },
    execution: { enabled: true },
  };
}

function rateBudget() {
  return {
    recommendedPollIntervalMs(value) { return value; },
    snapshot() { return { remaining: 4_000 }; },
  };
}

function runtime(queueRepository, poll) {
  return {
    queueRepository,
    config: config(),
    rateBudget: rateBudget(),
    stateStore: { async entries() { return []; } },
    taskSource: { poll },
    coordinator: { async executeTask(task) { return { issueNumber: task.issueNumber, status: 'completed' }; } },
  };
}

function runtimeSet(runtimes) {
  return {
    config: config(),
    selection: {
      records: runtimes.map((entry) => ({ name: entry.queueRepository, source: 'configured' })),
      discoveryEnabled: false,
      discoveredCount: 0,
      unchanged: true,
      truncated: false,
    },
    session: { rateBudget: rateBudget() },
    runtimes,
  };
}

test('runtime set shares one GitHub session while preserving one runtime per selected queue', async () => {
  const sharedSession = { client: {}, stateStore: {}, rateBudget: rateBudget() };
  const created = [];
  let catalogOptions;
  const set = await createRuntimeSet(config(), {
    sessionFactory: async () => sharedSession,
    catalogFactory(options) {
      catalogOptions = options;
      return {
        async list() {
          return {
            repositories: ['iteathen/DevBridge', 'iteathen/UCI_Arena'],
            records: [],
            discoveryEnabled: false,
            discoveredCount: 0,
            unchanged: true,
            truncated: false,
          };
        },
      };
    },
    async runtimeFactory(_config, options) {
      created.push(options);
      return { queueRepository: options.queueRepository };
    },
  });

  assert.equal(catalogOptions.client, sharedSession.client);
  assert.equal(catalogOptions.stateStore, sharedSession.stateStore);
  assert.deepEqual(created.map((entry) => entry.queueRepository), ['iteathen/DevBridge', 'iteathen/UCI_Arena']);
  assert.ok(created.every((entry) => entry.githubSession === sharedSession));
  assert.equal(set.runtimes.length, 2);
});

test('runtime set cycle scopes colliding issue numbers and continues after a repository-local failure', async () => {
  const set = runtimeSet([
    runtime('iteathen/DevBridge', async () => ({
      unchanged: false,
      tasks: [{ issueNumber: 7, revision: 'a'.repeat(64), envelope: { target: { repository: 'iteathen/DevBridge' } } }],
      rejected: [],
    })),
    runtime('iteathen/UCI_Arena', async () => { throw new Error('queue unavailable'); }),
  ]);

  const result = await runRuntimeSetCycle(set);
  assert.deepEqual(result.results, [{
    queueRepository: 'iteathen/DevBridge',
    issueNumber: 7,
    status: 'completed',
  }]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].queueRepository, 'iteathen/UCI_Arena');
  assert.match(result.errors[0].error.message, /queue unavailable/u);
});

test('shared rate-limit exhaustion stops the repository set globally', async () => {
  let secondPolled = false;
  const set = runtimeSet([
    runtime('iteathen/DevBridge', async () => { throw new RateLimitError('budget exhausted'); }),
    runtime('iteathen/UCI_Arena', async () => { secondPolled = true; return { tasks: [], rejected: [], unchanged: true }; }),
  ]);

  await assert.rejects(() => runRuntimeSetCycle(set), RateLimitError);
  assert.equal(secondPolled, false);
});
