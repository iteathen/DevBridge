import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDaemon } from '../src/app/daemon.js';
import { runOnce } from '../src/app/run-once.js';
import { daemonStatus } from '../src/runtime/daemon-lock.js';

test('runOnce cannot self-assert daemon coordination exclusivity', async () => {
  let observed = null;
  await assert.rejects(
    runOnce({ github: { queueRepositories: ['owner/queue'] } }, {
      env: {},
      fetchImpl: async () => { throw new Error('fetch should not run'); },
      collectionFactory: async (_config, options) => {
        observed = options;
        throw new Error('fixture runtime stop');
      },
    }),
    /fixture runtime stop/u,
  );
  assert.equal(observed.coordinationExclusive, false);
});

test('daemon grants same-identity takeover authority only after its singleton lock is held', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-daemon-coordination-'));
  const lockPath = path.join(directory, 'daemon.lock');
  let observed = null;

  await assert.rejects(
    runDaemon({ state: { directory } }, {
      collectionFactory: async (_config, options) => {
        observed = {
          options,
          lock: await daemonStatus(lockPath),
        };
        throw new Error('fixture runtime stop');
      },
    }),
    /fixture runtime stop/u,
  );

  assert.equal(observed.options.coordinationExclusive, true);
  assert.equal(observed.lock.activeLock, true);
  assert.equal((await daemonStatus(lockPath)).activeLock, false);
});
