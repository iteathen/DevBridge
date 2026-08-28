import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createImmutableSubjectRecordStateStore } from '../src/state/immutable-subject-record-state-store.js';

test('subject records publish once, survive restart, and reject substitution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-subject-record-'));
  const file = path.join(root, 'records.json');
  const subject = `subject-${'a'.repeat(32)}`;
  const record = { protocol: 'test/record-v1', mode: 'deferred' };
  try {
    const first = createImmutableSubjectRecordStateStore(file);
    assert.deepEqual(await first.save(subject, record), { changed: true });
    assert.deepEqual(await first.save(subject, { mode: 'deferred', protocol: 'test/record-v1' }), { changed: false });
    const second = createImmutableSubjectRecordStateStore(file);
    assert.deepEqual(await second.load(subject), record);
    await assert.rejects(() => second.save(subject, { ...record, mode: 'changed' }), /does not match/u);
    assert.throws(() => second.load('not-a-subject'), /subject is invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
