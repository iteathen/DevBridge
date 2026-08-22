import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RUNNER_SUBJECT_PROTOCOL } from '../src/entry/permanent-entry.mjs';
import { StableRunnerState } from '../src/entry/stable-runner-state.mjs';

function subject(head, digest, releaseId) {
  return {
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head,
    sha256: digest,
    minimumEntryProtocol: 1,
    channel: 'stable',
    releaseId,
  };
}

function record(value, acceptedAt) {
  return {
    subject: value,
    mode: 'development',
    sequence: null,
    manifestSha256: null,
    keyId: null,
    acceptedAt,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-entry-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, state: new StableRunnerState({ stateRoot: root }) };
}

test('stable runner state atomically rotates current to previous and preserves exact fallback order', async (t) => {
  const { state } = await fixture(t);
  const first = subject('1'.repeat(40), 'a'.repeat(64), 'development-one');
  const second = subject('2'.repeat(40), 'b'.repeat(64), 'development-two');

  const initial = await state.accept(record(first, '2026-08-22T12:00:00.000Z'));
  assert.equal(initial.revision, 1);
  assert.deepEqual(initial.current.subject, first);
  assert.equal(initial.previous, null);

  const rotated = await state.accept(record(second, '2026-08-22T12:01:00.000Z'));
  assert.equal(rotated.revision, 2);
  assert.deepEqual(rotated.current.subject, second);
  assert.deepEqual(rotated.previous.subject, first);

  assert.deepEqual(await state.fallback(second), first);
  assert.deepEqual(
    await state.fallback(subject('3'.repeat(40), 'c'.repeat(64), 'development-three')),
    second,
  );
});

test('re-accepting the same exact runner evidence does not rotate or rewrite stable state', async (t) => {
  const { root, state } = await fixture(t);
  const selected = subject('4'.repeat(40), 'd'.repeat(64), 'development-four');
  const accepted = await state.accept(record(selected, '2026-08-22T12:02:00.000Z'));
  const before = await readFile(path.join(root, 'stable-state.json'), 'utf8');

  const repeated = await state.accept(record(selected, '2026-08-22T13:00:00.000Z'));
  const after = await readFile(path.join(root, 'stable-state.json'), 'utf8');

  assert.equal(repeated.revision, accepted.revision);
  assert.equal(after, before);
});

test('stable runner status is bounded authority evidence and exposes no state-root path', async (t) => {
  const { root, state } = await fixture(t);
  const selected = subject('5'.repeat(40), 'e'.repeat(64), 'development-five');
  await state.accept(record(selected, '2026-08-22T12:03:00.000Z'));

  const status = await state.status();
  assert.equal(status.configured, true);
  assert.equal(status.revision, 1);
  assert.deepEqual(status.current.subject, selected);
  assert.equal(JSON.stringify(status).includes(root), false);
});

test('malformed or corrupt stable runner state fails closed instead of inventing LKG authority', async (t) => {
  const { root, state } = await fixture(t);
  await writeFile(path.join(root, 'stable-state.json'), '{not-json\n', 'utf8');
  await assert.rejects(() => state.read(), /not valid JSON/u);
  await assert.rejects(
    () => state.fallback(subject('6'.repeat(40), 'f'.repeat(64), 'development-six')),
    /not valid JSON/u,
  );
});
