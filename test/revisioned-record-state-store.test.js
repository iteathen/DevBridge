import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createRevisionedRecordStateStore } from '../src/state/revisioned-record-state-store.js';

const execute = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('./fixtures/revisioned-record-process.mjs', import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

test('revisioned records survive restart, isolate subjects, and reconcile only exact accepted writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-revisioned-record-'));
  const target = path.join(root, 'state.json');
  try {
    const first = createRevisionedRecordStateStore(target);
    await first.run('subject-one', async (session) => {
      assert.equal(await session.load(), undefined);
      assert.deepEqual(await session.save({ revision: 1, value: 'first' }), { changed: true, revision: 1 });
      assert.deepEqual(await session.save({ revision: 1, value: 'first' }), { changed: false, revision: 1 });
      await assert.rejects(() => session.save({ revision: 3, value: 'skipped' }), /revision changed/u);
      assert.deepEqual(await session.save({ revision: 2, value: 'second' }), { changed: true, revision: 2 });
      await assert.rejects(() => session.save({ revision: 2, value: 'conflict' }), /revision conflicts/u);
    });
    await first.run('subject-two', async (session) => {
      assert.equal(await session.load(), undefined);
      await session.save({ revision: 1, value: 'separate' });
    });

    const restarted = createRevisionedRecordStateStore(target);
    await restarted.run('subject-one', async (session) => {
      assert.deepEqual(await session.load(), { revision: 2, value: 'second' });
    });
    await restarted.run('subject-two', async (session) => {
      assert.deepEqual(await session.load(), { revision: 1, value: 'separate' });
    });
    const document = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(Object.keys(document).sort(), ['record:subject-one', 'record:subject-two']);
    assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exclusive record sessions serialize independent instances and release after failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-record-session-'));
  const target = path.join(root, 'state.json');
  const entered = deferred();
  const release = deferred();
  try {
    const first = createRevisionedRecordStateStore(target);
    const second = createRevisionedRecordStateStore(target);
    let secondEntered = false;
    const holding = first.run('subject-one', async (session) => {
      await session.save({ revision: 1, value: 'held' });
      entered.resolve();
      await release.promise;
      await session.save({ revision: 2, value: 'released' });
      return 'first';
    });
    await entered.promise;
    const waiting = second.run('subject-one', async (session) => {
      secondEntered = true;
      assert.deepEqual(await session.load(), { revision: 2, value: 'released' });
      return 'second';
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondEntered, false);
    release.resolve();
    assert.deepEqual(await Promise.all([holding, waiting]), ['first', 'second']);

    await assert.rejects(() => first.run('subject-two', () => { throw new Error('operation stopped'); }), /operation stopped/u);
    assert.equal(await second.run('subject-two', async (session) => session.load()), undefined);
  } finally {
    release.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid subjects, non-JSON records, and corrupt documents fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-record-invalid-'));
  const target = path.join(root, 'state.json');
  try {
    const store = createRevisionedRecordStateStore(target);
    await assert.rejects(() => store.run(' subject', async () => {}), /subject is invalid/u);
    await store.run('subject-one', async (session) => {
      await assert.rejects(() => session.save({ revision: 1, omitted: undefined }), /exact JSON/u);
      assert.equal(await session.load(), undefined);
    });

    await writeFile(target, '[]\n', 'utf8');
    await assert.rejects(() => store.run('subject-one', (session) => session.load()), /root must be an object/u);
    assert.equal(await readFile(target, 'utf8'), '[]\n');

    await writeFile(target, '{"record:subject-one":{"revision":0}}\n', 'utf8');
    await assert.rejects(() => store.run('subject-one', (session) => session.load()), /stored record.revision is invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an exact record written by one process is resumed by a fresh process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-record-process-'));
  const target = path.join(root, 'state.json');
  try {
    const written = await execute(process.execPath, [FIXTURE, 'save', target, 'subject-one', JSON.stringify({ revision: 1, value: 'durable' })], {
      windowsHide: true,
    });
    assert.deepEqual(JSON.parse(written.stdout), { changed: true, revision: 1 });
    const loaded = await execute(process.execPath, [FIXTURE, 'load', target, 'subject-one'], { windowsHide: true });
    assert.deepEqual(JSON.parse(loaded.stdout), { revision: 1, value: 'durable' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
