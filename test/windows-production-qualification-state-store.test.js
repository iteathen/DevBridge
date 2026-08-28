import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWindowsProductionQualificationStateStore } from '../src/state/windows-production-qualification-state-store.js';

test('Windows production qualification state remains scoped to its exact subject', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-qualification-state-'));
  const location = path.join(root, 'state.json');
  try {
    const store = createWindowsProductionQualificationStateStore(location);
    await store.save('subject-a', { phase: 'planned' });
    await store.save('subject-b', { phase: 'qualified' });
    assert.deepEqual(await store.load('subject-a'), { phase: 'planned' });
    assert.deepEqual(await store.load('subject-b'), { phase: 'qualified' });
    const persisted = await readFile(location, 'utf8');
    assert.match(persisted, /windows-production-qualification:subject-a/u);
    assert.match(persisted, /windows-production-qualification:subject-b/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
