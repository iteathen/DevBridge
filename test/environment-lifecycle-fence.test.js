import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createEnvironmentLifecycleFence } from '../src/app/environment-lifecycle-fence.js';

test('lifecycle fence forwards one exact neutral request and preserves its subject', async () => {
  const calls = [];
  let releases = 0;
  const fence = createEnvironmentLifecycleFence({
    admission: {
      async acquire(request) {
        calls.push(request);
        return { subject: request.subject, async release() { releases += 1; } };
      },
    },
  });
  const held = await fence.acquire({ subject: 'environment-1', operationId: 'operation-1' });
  assert.equal(held.subject, 'environment-1');
  assert.deepEqual(calls, [{ subject: 'environment-1', operationId: 'operation-1' }]);
  await held.release();
  assert.equal(releases, 1);
});

test('lifecycle fence rejects widened requests and inexact admission evidence', async () => {
  const fence = createEnvironmentLifecycleFence({
    admission: { async acquire() { return { subject: 'other', release: async () => {} }; } },
  });
  await assert.rejects(
    fence.acquire({ subject: 'environment-1', operationId: 'operation-1', path: '/foreign' }),
    /unknown field/u,
  );
  await assert.rejects(
    fence.acquire({ subject: 'environment-1', operationId: 'operation-1' }),
    /evidence is invalid/u,
  );
  assert.throws(() => createEnvironmentLifecycleFence(), /admission contract/u);
});

test('lifecycle fence source contains no topology or participant identities', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/app/environment-lifecycle-fence.js', import.meta.url)), 'utf8');
  for (const forbidden of ['daemon.lock', 'pauseDaemon', 'resumeDaemon', 'linux', 'win32', 'systemd', 'flock', 'provider']) {
    assert.equal(source.includes(forbidden), false, `neutral lifecycle fence must not contain ${forbidden}`);
  }
});
