import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCommand } from '../src/runtime/command-invocation.js';

test('local command invocation never uses a shell and captures bounded structured results', async () => {
  const result = await invokeCommand({
    executable: process.execPath,
    arguments: ['-e', 'process.stdout.write("ok"); process.stderr.write("note")'],
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, 'note');
  assert.equal(result.outputTruncated, false);
});

test('output is bounded across streams', async () => {
  const result = await invokeCommand({
    executable: process.execPath,
    arguments: ['-e', 'process.stdout.write("x".repeat(5000))'],
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  });
  assert.equal(result.stdout.length, 1_024);
  assert.equal(result.outputTruncated, true);
});

test('a pre-cancelled request returns without starting a child effect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-command-cancelled-'));
  const marker = path.join(root, 'started.txt');
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await invokeCommand({
      executable: process.execPath,
      arguments: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      signal: controller.signal,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    assert.equal(result.exitCode, null);
    assert.equal(result.aborted, true);
    await assert.rejects(() => readFile(marker), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
