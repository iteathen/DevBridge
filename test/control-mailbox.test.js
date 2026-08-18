import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlMailbox } from '../src/runtime/control-mailbox.js';

test('control mailbox is outside project state, unique per run/turn invocation, and consumes a pre-created result inode', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-mailbox-'));
  const projectDir = path.join(parent, 'project');
  const exchangeRoot = path.join(parent, 'control-state', 'exchange');
  await mkdir(projectDir, { recursive: true });
  const mailbox = new ControlMailbox({ root: exchangeRoot });

  const first = await mailbox.prepare({ runId: 'run-a', turnId: 'turn-1' });
  const second = await mailbox.prepare({ runId: 'run-b', turnId: 'turn-1' });
  assert.equal(first.exchangeDir.startsWith(`${projectDir}${path.sep}`), false);
  assert.notEqual(first.exchangeDir, second.exchangeDir);
  assert.notEqual(first.runDigest, second.runDigest);

  await mailbox.writeContext(first, '{"context":true}\n');
  await writeFile(first.resultFile, '{"protocol":"patch-poller/result-v1","status":"complete","summary":"ok"}\n', 'utf8');
  const consumed = await mailbox.consumeResult(first);
  assert.match(consumed.text, /patch-poller\/result-v1/u);
  const identity = await mailbox.readIdentity(first);
  assert.equal(identity.runDigest, first.runDigest);
  assert.equal(identity.turnId, first.turnId);
});

test('result consumption rejects directory substitution and changed endpoint identity', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-mailbox-substitute-'));
  const mailbox = new ControlMailbox({ root: path.join(parent, 'exchange') });
  const exchange = await mailbox.prepare({ runId: 'run-a', turnId: 'turn-1' });
  await rm(exchange.resultFile, { force: true });
  await mkdir(exchange.resultFile);
  await assert.rejects(() => mailbox.consumeResult(exchange), /substituted|identity changed/u);
});

test('control mailbox root refuses symlink or junction substitution', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-mailbox-root-'));
  const outside = path.join(parent, 'outside');
  const root = path.join(parent, 'exchange');
  await mkdir(outside);
  try {
    await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`filesystem cannot create test indirection: ${error.code}`);
      return;
    }
    throw error;
  }
  const mailbox = new ControlMailbox({ root });
  await assert.rejects(() => mailbox.prepare({ runId: 'run-a', turnId: 'turn-1' }), /real control-owned directory/u);
});
