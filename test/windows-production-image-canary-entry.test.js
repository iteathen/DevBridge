import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWindowsProductionImageCanaryEntry } from '../src/entry/windows-production-image-canary-entry.mjs';

test('Windows physical canary entry keeps inspection and mutation explicit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-image-entry-'));
  const config = path.join(root, 'config.json');
  await writeFile(config, '{"local":true}\n');
  const calls = [];
  let output = '';
  const factory = (value) => {
    assert.equal(value.local, true);
    return { async status() { calls.push('status'); return { blocked: false, state: 'absent' }; }, async run() { calls.push('run'); return { blocked: true, state: 'blocked' }; } };
  };
  try {
    assert.equal(await runWindowsProductionImageCanaryEntry(['status', '--config', config], { factory, stdout: { write(value) { output += value; } } }), 0);
    assert.equal(JSON.parse(output).state, 'absent');
    output = '';
    assert.equal(await runWindowsProductionImageCanaryEntry(['run', '--config', config], { factory, stdout: { write(value) { output += value; } } }), 2);
    assert.equal(JSON.parse(output).state, 'blocked');
    assert.deepEqual(calls, ['status', 'run']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows physical canary entry rejects implicit and relative config authority', async () => {
  const factory = () => ({ async status() {}, async run() {} });
  await assert.rejects(() => runWindowsProductionImageCanaryEntry(['run'], { factory }), /usage/u);
  await assert.rejects(() => runWindowsProductionImageCanaryEntry(['run', '--config', 'relative.json'], { factory }), /must be absolute/u);
});
