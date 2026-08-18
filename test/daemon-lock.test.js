import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireDaemonLock } from '../src/runtime/daemon-lock.js';
import { PolicyError } from '../src/errors.js';

test('daemon lock prevents concurrent ownership and releases only its own token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-lock-'));
  const file = path.join(root, 'daemon.lock');
  const release = await acquireDaemonLock(file);
  await assert.rejects(() => acquireDaemonLock(file), PolicyError);
  await release();
  const releaseAgain = await acquireDaemonLock(file);
  await releaseAgain();
});
