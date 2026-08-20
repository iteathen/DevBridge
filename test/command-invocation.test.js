import test from 'node:test';
import assert from 'node:assert/strict';
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
