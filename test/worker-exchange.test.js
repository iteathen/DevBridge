import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerExchange } from '../src/runtime/worker-exchange.js';

async function tempExchange() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-worker-exchange-'));
  return { root, exchange: new WorkerExchange({ root: path.join(root, 'control-mailboxes') }) };
}

test('creates context/result endpoints under a control-owned root with exact run/turn binding', async () => {
  const fixture = await tempExchange();
  try {
    const mailbox = await fixture.exchange.prepare({
      runId: 'run-1',
      turnId: 'turn-1',
      context: ({ resultFile }) => ({ run: 'run-1', turn: 'turn-1', resultFile }),
    });
    assert.equal(mailbox.runId, 'run-1');
    assert.equal(mailbox.turnId, 'turn-1');
    assert.equal(path.resolve(mailbox.contextFile).startsWith(path.resolve(fixture.root) + path.sep), true);
    assert.equal(path.resolve(mailbox.resultFile).startsWith(path.resolve(fixture.root) + path.sep), true);
    const context = JSON.parse(await readFile(mailbox.contextFile, 'utf8'));
    assert.equal(context.resultFile, mailbox.resultFile);
    const resultInfo = await lstat(mailbox.resultFile);
    assert.equal(resultInfo.isFile(), true);
    assert.equal(resultInfo.isSymbolicLink(), false);
    await mailbox.cleanup();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects precreated turn directories and traversal-shaped run or turn identities', async () => {
  const fixture = await tempExchange();
  try {
    await fixture.exchange.ensureRoot();
    await mkdir(path.join(fixture.exchange.root, 'run-1'), { mode: 0o700 });
    await mkdir(path.join(fixture.exchange.root, 'run-1', 'turn-1'), { mode: 0o700 });
    await assert.rejects(fixture.exchange.prepare({ runId: 'run-1', turnId: 'turn-1', context: {} }), /already exists/u);
    await assert.rejects(fixture.exchange.prepare({ runId: '../other', turnId: 'turn-2', context: {} }), /safe exchange identifier/u);
    await assert.rejects(fixture.exchange.prepare({ runId: 'run-2', turnId: '../other', context: {} }), /safe exchange identifier/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects result-file replacement even when the replacement is another regular file', async () => {
  const fixture = await tempExchange();
  try {
    const mailbox = await fixture.exchange.prepare({ runId: 'run-1', turnId: 'turn-1', context: {} });
    await rm(mailbox.resultFile);
    await writeFile(mailbox.resultFile, '{"protocol":"patch-poller/result-v1"}\n');
    await assert.rejects(mailbox.consumeResult(), /identity changed/u);
    await mailbox.cleanup();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects directory substitution for a result endpoint', async () => {
  const fixture = await tempExchange();
  try {
    const mailbox = await fixture.exchange.prepare({ runId: 'run-1', turnId: 'turn-1', context: {} });
    await rm(mailbox.resultFile);
    await mkdir(mailbox.resultFile);
    await assert.rejects(mailbox.consumeResult(), /non-regular filesystem object/u);
    await mailbox.cleanup();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects symlink result substitution where the platform permits creating one', async (t) => {
  const fixture = await tempExchange();
  try {
    const mailbox = await fixture.exchange.prepare({ runId: 'run-1', turnId: 'turn-1', context: {} });
    const outside = path.join(fixture.root, 'outside-result.json');
    await writeFile(outside, '{}\n');
    await rm(mailbox.resultFile);
    try {
      await symlink(outside, mailbox.resultFile, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`platform does not permit symlink fixture: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(mailbox.consumeResult(), /non-regular filesystem object/u);
    await mailbox.cleanup();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
