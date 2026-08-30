import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConstructionRetentionStateStore } from '../src/state/construction-retention-state-store.js';

test('retention state store isolates subject records and lists durable receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-retention-store-'));
  try {
    const store = createConstructionRetentionStateStore(path.join(root, 'state.json'));
    await store.save('subject-11111111111111111111111111111111', { revision: 1 });
    await store.save('subject-22222222222222222222222222222222', { revision: 2 });
    assert.deepEqual(await store.load('subject-11111111111111111111111111111111'), { revision: 1 });
    assert.deepEqual((await store.list()).map((entry) => entry.identity), [
      'subject-11111111111111111111111111111111',
      'subject-22222222222222222222222222222222',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
