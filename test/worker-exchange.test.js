import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerExchange, WORKER_CONTEXT_TRANSFER, WORKER_RESULT_TRANSFER } from '../src/runtime/worker-exchange.js';

async function withRoot(prefix, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const resultEnvelope = `${JSON.stringify({ protocol: 'devbridge/result-v1', status: 'complete', summary: 'worker result survived restart' })}\n`;

test('control-owned exchange exposes capability transfers, not environment-local paths', async () => {
  await withRoot('db-worker-exchange-ports-', async (root) => {
    const stateDirectory = path.join(root, 'state');
    await mkdir(stateDirectory, { mode: 0o755 });
    await chmod(stateDirectory, 0o755);
    const mailbox = await new WorkerExchange({ stateDirectory }).prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: { objective: 'recover me' } });
    if (process.getuid?.() != null) {
      assert.equal((await stat(stateDirectory)).mode & 0o077, 0);
      assert.equal((await stat(mailbox.contextFile)).mode & 0o077, 0);
      assert.equal((await stat(mailbox.resultFile)).mode & 0o077, 0);
    }
    const input = mailbox.inputTransfer();
    const output = mailbox.outputTransfer();
    assert.equal(input.name, WORKER_CONTEXT_TRANSFER);
    assert.equal(output.name, WORKER_RESULT_TRANSFER);
    assert.equal(typeof input.port.read, 'function');
    assert.equal(typeof output.port.write, 'function');
    assert.doesNotMatch(JSON.stringify({ name: input.name, direction: input.direction }), /\/run\/|sandbox/u);
    const context = JSON.parse((await input.port.read()).toString('utf8'));
    assert.equal(context.objective, 'recover me');
    await output.port.write(resultEnvelope);
    const consumed = await mailbox.consumeResult();
    assert.equal(consumed.text, resultEnvelope);
  });
});

test('fresh control-plane instance reopens exact exchange identity', async () => {
  await withRoot('db-worker-exchange-recovery-', async (root) => {
    const stateDirectory = path.join(root, 'state');
    const mailbox = await new WorkerExchange({ stateDirectory }).prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: { objective: 'recover' } });
    await writeFile(mailbox.resultFile, resultEnvelope, { encoding: 'utf8' });
    const recovered = await new WorkerExchange({ stateDirectory }).openTurn({ runId: 'run-1', turnId: 'turn-1' });
    assert.equal((await recovered.consumeResult()).text, resultEnvelope);
  });
});

test('exchange rejects traversal and pre-created turn identity', async () => {
  await withRoot('db-worker-exchange-precreate-', async (root) => {
    const exchange = new WorkerExchange({ stateDirectory: path.join(root, 'state') });
    await assert.rejects(() => exchange.prepareTurn({ runId: '../other-run', turnId: 'turn-1', context: {} }), /safe worker-exchange identity segment/u);
    await mkdir(path.join(exchange.rootDirectory, 'run-1', 'turn-1'), { recursive: true, mode: 0o700 });
    await assert.rejects(() => exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: {} }), /turn already exists/u);
  });
});

test('exact run and turn identities prevent cross-run result confusion', async () => {
  await withRoot('db-worker-exchange-cross-run-', async (root) => {
    const exchange = new WorkerExchange({ stateDirectory: path.join(root, 'state') });
    const first = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: { run: 1 } });
    const second = await exchange.prepareTurn({ runId: 'run-2', turnId: 'turn-1', context: { run: 2 } });
    await second.outputTransfer().port.write(resultEnvelope);
    assert.equal((await first.consumeResult()).text, null);
    assert.equal((await second.consumeResult()).text, resultEnvelope);
    assert.notEqual(first.resultFile, second.resultFile);
  });
});

test('result consumption rejects replacement, directory substitution, and symlink substitution', async (t) => {
  await withRoot('db-worker-exchange-replace-', async (root) => {
    const exchange = new WorkerExchange({ stateDirectory: path.join(root, 'state') });
    const replaced = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: {} });
    await rm(replaced.resultFile);
    await writeFile(replaced.resultFile, resultEnvelope, { mode: 0o600 });
    await assert.rejects(() => replaced.consumeResult(), /replaced after DevBridge established worker-exchange ownership/u);

    const directory = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-2', context: {} });
    await rm(directory.resultFile);
    await mkdir(directory.resultFile, { mode: 0o700 });
    await assert.rejects(() => directory.consumeResult(), /real regular file/u);

    const linked = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-3', context: {} });
    const outside = path.join(root, 'outside-result.json');
    await writeFile(outside, resultEnvelope, { mode: 0o600 });
    await rm(linked.resultFile);
    try { await symlink(outside, linked.resultFile, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) { t.skip(`symlink unavailable: ${error.code}`); return; }
      throw error;
    }
    await assert.rejects(() => linked.consumeResult(), /real regular file/u);
  });
});

test('context mutation and oversized results fail closed', async () => {
  await withRoot('db-worker-exchange-integrity-', async (root) => {
    const exchange = new WorkerExchange({ stateDirectory: path.join(root, 'state') });
    const tampered = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: { objective: 'immutable' } });
    await writeFile(tampered.contextFile, '{"objective":"tampered"}\n');
    await assert.rejects(() => tampered.consumeResult(), /modified its control-plane-owned context file/u);

    const large = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-2', context: {} });
    await writeFile(large.resultFile, 'x'.repeat(2048));
    const consumed = await large.consumeResult({ maxBytes: 1024 });
    assert.equal(consumed.text, null);
    assert.equal(consumed.resultParseError, 'result file exceeds 1024 bytes');
  });
});
