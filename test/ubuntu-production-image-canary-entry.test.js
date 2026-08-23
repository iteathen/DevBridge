import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runUbuntuProductionImageCanaryEntry } from '../src/entry/ubuntu-production-image-canary-entry.mjs';

function output() {
  let text = '';
  return { stream: { write(value) { text += value; } }, read: () => text };
}

test('physical canary entry keeps status and run as distinct explicit surfaces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-entry-'));
  const config = path.join(root, 'config.json');
  await writeFile(config, '{"marker":"local"}\n');
  const calls = [];
  const factory = (value) => {
    assert.equal(value.marker, 'local');
    return {
      async status() { calls.push('status'); return { state: 'absent', blocked: false }; },
      async run() { calls.push('run'); return { state: 'waiting', blocked: false }; },
    };
  };
  try {
    const statusOut = output();
    assert.equal(await runUbuntuProductionImageCanaryEntry(['status', '--config', config], { factory, stdout: statusOut.stream }), 0);
    assert.deepEqual(JSON.parse(statusOut.read()), { state: 'absent', blocked: false });
    assert.deepEqual(calls, ['status']);

    const runOut = output();
    assert.equal(await runUbuntuProductionImageCanaryEntry(['run', '--config', config], { factory, stdout: runOut.stream }), 0);
    assert.deepEqual(JSON.parse(runOut.read()), { state: 'waiting', blocked: false });
    assert.deepEqual(calls, ['status', 'run']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary entry returns a distinct blocked exit code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-image-entry-blocked-'));
  const config = path.join(root, 'config.json');
  await writeFile(config, '{}\n');
  try {
    const out = output();
    const factory = () => ({ async status() { return { state: 'blocked', blocked: true, reason: 'not ready' }; }, async run() { throw new Error('run must not be called'); } });
    assert.equal(await runUbuntuProductionImageCanaryEntry(['status', '--config', config], { factory, stdout: out.stream }), 2);
    assert.equal(JSON.parse(out.read()).reason, 'not ready');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary entry rejects implicit or relative host mutation inputs', async () => {
  const factory = () => ({ async status() {}, async run() {} });
  const out = output();
  await assert.rejects(() => runUbuntuProductionImageCanaryEntry(['run'], { factory, stdout: out.stream }), /usage/u);
  await assert.rejects(() => runUbuntuProductionImageCanaryEntry(['run', '--config', 'relative.json'], { factory, stdout: out.stream }), /must be absolute/u);
  await assert.rejects(() => runUbuntuProductionImageCanaryEntry(['status', '--config', '/tmp/a', '--extra'], { factory, stdout: out.stream }), /usage/u);
});
