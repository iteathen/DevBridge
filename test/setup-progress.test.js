import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSetupProgress, formatSetupProgress } from '../src/setup/setup-progress.js';

test('setup progress reports bounded neutral elapsed phase evidence with a fake clock', async () => {
  let time = 1_000;
  const events = [];
  const progress = createSetupProgress({ onProgress: (event) => events.push(event), clock: () => time });
  const value = await progress.run('authority-discovery', async () => {
    time += 2_750;
    return 42;
  }, 'immutable local subject');

  assert.equal(value, 42);
  assert.deepEqual(events.map(({ sequence, phase, state, elapsedMilliseconds, detail }) => ({ sequence, phase, state, elapsedMilliseconds, detail })), [
    { sequence: 1, phase: 'authority-discovery', state: 'started', elapsedMilliseconds: 0, detail: 'immutable local subject' },
    { sequence: 2, phase: 'authority-discovery', state: 'completed', elapsedMilliseconds: 2_750, detail: null },
  ]);
  assert.equal(formatSetupProgress(events[1]), '[setup 2s] authority-discovery: completed\n');
});

test('setup progress contains callback failures and redacts multiline unbounded detail', () => {
  const progress = createSetupProgress({ onProgress: () => { throw new Error('observer failed'); }, clock: () => 0 });
  const event = progress.emit('checkpoint', 'saved', `${'x'.repeat(300)}\nsecret-line`);
  assert.equal(event.detail.length, 240);
  assert.equal(event.detail.includes('\n'), false);
});

test('setup progress is a neutral observation LEGO with no setup effect authority', async () => {
  const source = (await readFile(new URL('../src/setup/setup-progress.js', import.meta.url), 'utf8')).toLowerCase();
  for (const identity of ['github', 'provider', 'powershell', 'elevation', 'construction', 'child_process', 'node:fs']) {
    assert.equal(source.includes(identity), false, identity);
  }
});
