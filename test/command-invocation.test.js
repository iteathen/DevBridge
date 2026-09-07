import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCommandInvoker, invokeCommand } from '../src/runtime/command-invocation.js';

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

test('a locally composed command invoker admits only its explicit long-transaction ceiling', async () => {
  const invokeLongTransaction = createCommandInvoker({ maximumTimeoutMs: 45 * 60_000 });
  const request = {
    executable: process.execPath,
    arguments: ['-e', 'process.stdout.write("long-policy-ok")'],
    timeoutMs: 45 * 60_000,
    maxOutputBytes: 4_096,
  };
  await assert.rejects(invokeCommand(request), /command timeoutMs must be an integer between 100 and 300000/u);
  const result = await invokeLongTransaction(request);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'long-policy-ok');
  await assert.rejects(invokeLongTransaction({ ...request, timeoutMs: (45 * 60_000) + 1 }), /command timeoutMs/u);
  assert.throws(() => createCommandInvoker({ maximumTimeoutMs: (45 * 60_000) + 1 }), /command invoker policy.maximumTimeoutMs/u);
  assert.throws(() => createCommandInvoker({ maximumTimeoutMs: 45 * 60_000, executable: process.execPath }), /policy.executable is not allowed/u);
});

test('local command visibility is a closed composition policy and remains hidden by default', async () => {
  const request = {
    executable: process.execPath,
    arguments: ['-e', 'process.stdout.write("visibility-policy-ok")'],
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  };
  const defaultInvoker = createCommandInvoker({ maximumTimeoutMs: 45 * 60_000 });
  const visibleInvoker = createCommandInvoker({ maximumTimeoutMs: 45 * 60_000, windowsHide: false });
  assert.equal((await defaultInvoker(request)).stdout, 'visibility-policy-ok');
  assert.equal((await visibleInvoker(request)).stdout, 'visibility-policy-ok');
  assert.throws(
    () => createCommandInvoker({ maximumTimeoutMs: 45 * 60_000, windowsHide: 'false' }),
    /policy.windowsHide must be a boolean/u,
  );
});
