import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GITHUB_RUNTIME_CONTEXT_PROTOCOL } from '../src/app/github-runtime-context.js';
import { pollOnce } from '../src/app/poll-once.js';

test('poll-once visits configured queues serially through one shared client and isolates ordinary failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-poll-collection-'));
  const client = {};
  const context = {
    protocol: GITHUB_RUNTIME_CONTEXT_PROTOCOL,
    stateStore: {},
    rateBudget: {
      snapshot: () => ({ remaining: 50 }),
      recommendedPollIntervalMs: (value, options) => {
        assert.equal(options.estimatedRequestsPerCycle, 4);
        return value;
      },
    },
    tokenProvider: async () => null,
    client,
    secretValues: [],
  };
  const config = {
    github: {
      queueRepositories: ['owner/one', 'owner/two'],
      taskLabel: 'devbridge:ready',
      trustedActorIds: ['1'],
      pollIntervalMs: 60_000,
      apiVersion: '2026-03-10',
      rateLimit: {},
      auth: {},
    },
    state: { directory: path.join(root, 'state') },
    workspace: { root: path.join(root, 'work'), allowCreate: true, allowedOwners: ['owner'], externalReadRoots: [] },
  };
  const calls = [];
  const result = await pollOnce(config, {
    contextFactory: async (input) => {
      assert.equal(Object.hasOwn(input, 'queueRepositories'), false);
      return context;
    },
    sourceFactory: (options) => ({
      async poll() {
        calls.push(options.queueRepository);
        assert.equal(options.client, client);
        if (options.queueRepository === 'owner/two') throw new Error('queue unavailable');
        return {
          unchanged: false,
          pollIntervalMs: 75_000,
          rejected: [{ issueNumber: 2, reason: 'untrusted' }],
          tasks: [{ issueNumber: 1, queueRepository: 'forged/value', envelope: { target: { repository: 'owner/project' } } }],
        };
      },
    }),
  });

  assert.deepEqual(calls, ['owner/one', 'owner/two']);
  assert.equal(result.tasks[0].queueRepository, 'owner/one');
  assert.equal(result.rejected[0].queueRepository, 'owner/one');
  assert.equal(result.queues[1].ready, false);
  assert.equal(result.recommendedPollIntervalMs, 75_000);
  assert.deepEqual(result.rateLimit, { remaining: 50 });
});
