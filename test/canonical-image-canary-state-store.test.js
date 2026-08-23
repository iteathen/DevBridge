import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanonicalImageCanaryStateStore } from '../src/state/canonical-image-canary-state-store.js';

const IDENTITY = `subject-${'7'.repeat(32)}`;

test('canonical image canary journal survives a fresh state-store instance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-image-canary-state-'));
  const file = path.join(directory, 'state.json');
  const record = {
    protocol: 'devbridge/canonical-image-canary-v1',
    identity: IDENTITY,
    requestDigest: '8'.repeat(64),
    revision: 3,
    phase: 'probed',
    probe: { ready: true },
    finalization: null,
    image: null,
  };
  try {
    await createCanonicalImageCanaryStateStore(file).save(IDENTITY, record);
    const restored = await createCanonicalImageCanaryStateStore(file).load(IDENTITY);
    assert.deepEqual(restored, record);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
