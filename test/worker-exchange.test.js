import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerExchange, WORKER_CONTEXT_FILE, WORKER_RESULT_FILE } from '../src/runtime/worker-exchange.js';

async function withRoot(prefix, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const resultEnvelope = `${JSON.stringify({
  protocol: 'devbridge/result-v1',
  status: 'complete',
  summary: 'worker result survived restart',
})}\n`;

test('control-owned mailbox hardens state permissions and survives a fresh control-plane instance', async () => {
  await withRoot('pp-worker-exchange-recovery-', async (root) => {
    const stateDirectory = path.join(root, 'state');
    await mkdir(stateDirectory, { mode: 0o755 });
    await chmod(stateDirectory, 0o755);
    const exchange = new WorkerExchange({ stateDirectory });
    const mailbox = await exchange.prepareTurn({
      runId: 'run-1',
      turnId: 'turn-1',
      context: { objective: 'recover me' },
    });

    if (process.getuid?.() != null) {
      const stateInfo = await stat(stateDirectory);
      assert.equal(stateInfo.mode & 0o077, 0);
      const contextInfo = await stat(mailbox.contextFile);
      const resultInfo = await stat(mailbox.resultFile);
      assert.equal(contextInfo.mode & 0o077, 0);
      assert.equal(resultInfo.mode & 0o077, 0);
    }

    assert.equal(path.relative(stateDirectory, mailbox.contextFile).startsWith('..'), false);
    assert.equal(path.relative(stateDirectory, mailbox.resultFile).startsWith('..'), false);
    assert.equal(mailbox.workerContextFile, WORKER_CONTEXT_FILE);
    assert.equal(mailbox.workerResultFile, WORKER_RESULT_FILE);
    assert.deepEqual(Object.keys(mailbox.sandboxIpc()).sort(), [
      'contextSource', 'contextTarget', 'protocol', 'resultSource', 'resultTarget', 'transport',
    ]);

    await writeFile(mailbox.resultFile, resultEnvelope, { encoding: 'utf8' });

    const recoveredExchange = new WorkerExchange({ stateDirectory });
    const recovered = await recoveredExchange.openTurn({ runId: 'run-1', turnId: 'turn-1' });
    const consumed = await recovered.consumeResult();
    assert.equal(consumed.resultParseError, null);
    assert.equal(consumed.text, resultEnvelope);
  });
});

test('host staging transport imports only a stable worker-owned result into the authoritative mailbox', async () => {
  await withRoot('pp-worker-exchange-staging-', async (root) => {
    const stateDirectory = path.join(root, 'state');
    const exchange = new WorkerExchange({ stateDirectory });
    const mailbox = await exchange.prepareTurn({
      runId: 'run-1',
      turnId: 'turn-1',
      context: { objective: 'stage result' },
      targetMode: 'host-staging-file',
    });

    assert.equal(path.resolve(mailbox.workerContextFile), path.resolve(mailbox.contextFile));
    assert.equal(path.basename(mailbox.workerResultFile), 'worker-result-staging.json');
    assert.notEqual(path.resolve(mailbox.workerResultFile), path.resolve(mailbox.resultFile));
    await writeFile(mailbox.workerResultFile, resultEnvelope, { encoding: 'utf8' });

    const consumed = await mailbox.consumeResult();
    assert.equal(consumed.resultParseError, null);
    assert.equal(consumed.text, resultEnvelope);
    assert.equal(await readFile(mailbox.resultFile, 'utf8'), resultEnvelope);

    const recovered = await new WorkerExchange({ stateDirectory }).openTurn({ runId: 'run-1', turnId: 'turn-1' });
    const recoveredResult = await recovered.consumeResult();
    assert.equal(recoveredResult.text, resultEnvelope);
  });
});

test('host staging transport rejects replacement before importing worker output', async () => {
  await withRoot('pp-worker-exchange-staging-replace-', async (root) => {
    const exchange = new WorkerExchange({ stateDirectory: path.join(root, 'state') });
    const mailbox = await exchange.prepareTurn({
      runId: 'run-1',
      turnId: 'turn-1',
      context: {},
      targetMode: 'host-staging-file',
    });
    await rm(mailbox.workerResultFile);
    await writeFile(mailbox.workerResultFile, resultEnvelope, { mode: 0o600 });
    await assert.rejects(
      () => mailbox.consumeResult(),
      /replaced after DevBridge established worker-exchange ownership/u,
    );
    assert.equal(await readFile(mailbox.resultFile, 'utf8'), '');
  });
});

test('worker exchange rejects path traversal and a pre-created turn mailbox', async () => {
  await withRoot('pp-worker-exchange-precreate-', async (root) => {
    const stateDirectory = path.join(root, 'state');
    const exchange = new WorkerExchange({ stateDirectory });
    await assert.rejects(
      () => exchange.prepareTurn({ runId: '../other-run', turnId: 'turn-1', context: {} }),
      /safe worker-exchange identity segment/u,
    );

    await mkdir(path.join(exchange.rootDirectory, 'run-1', 'turn-1'), { recursive: true, mode: 0o700 });
    await assert.rejects(
      () => exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: {} }),
      /turn already exists/u,
    );
  });
});

test('exact run and turn identities prevent cross-run result confusion', async () => {
  await withRoot('pp-worker-exchange-cross-run-', async (root) => {
    const stateDirectory = path.join(root, 'state');
    const exchange = new WorkerExchange({ stateDirectory });
    const first = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: { run: 1 } });
    const second = await exchange.prepareTurn({ runId: 'run-2', turnId: 'turn-1', context: { run: 2 } });
    const secondEnvelope = `${JSON.stringify({
      protocol: 'devbridge/result-v1',
      status: 'complete',
      summary: 'run two only',
    })}\n`;
    await writeFile(second.resultFile, secondEnvelope, { encoding: 'utf8' });

    const reopenedFirst = await exchange.openTurn({ runId: 'run-1', turnId: 'turn-1' });
    const reopenedSecond = await exchange.openTurn({ runId: 'run-2', turnId: 'turn-1' });
    const firstConsumed = await reopenedFirst.consumeResult();
    const secondConsumed = await reopenedSecond.consumeResult();
    assert.equal(firstConsumed.text, null);
    assert.equal(secondConsumed.text, secondEnvelope);
    assert.notEqual(first.resultFile, second.resultFile);
  });
});

test('result consumption rejects regular-file replacement and directory substitution', async () => {
  await withRoot('pp-worker-exchange-replace-', async (root) => {
    const stateDirectory = path.join(root, 'state');
    const exchange = new WorkerExchange({ stateDirectory });
    const replaced = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: {} });
    await rm(replaced.resultFile);
    await writeFile(replaced.resultFile, resultEnvelope, { mode: 0o600 });
    await assert.rejects(
      () => replaced.consumeResult(),
      /replaced after DevBridge established worker-exchange ownership/u,
    );

    const directory = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-2', context: {} });
    await rm(directory.resultFile);
    await mkdir(directory.resultFile, { mode: 0o700 });
    await assert.rejects(
      () => directory.consumeResult(),
      /real regular file/u,
    );
  });
});

test('result consumption rejects symlink substitution where the host supports symlinks', async (t) => {
  await withRoot('pp-worker-exchange-symlink-', async (root) => {
    const stateDirectory = path.join(root, 'state');
    const outside = path.join(root, 'outside-result.json');
    await writeFile(outside, resultEnvelope, { mode: 0o600 });
    const exchange = new WorkerExchange({ stateDirectory });
    const mailbox = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: {} });
    await rm(mailbox.resultFile);
    try {
      await symlink(outside, mailbox.resultFile, 'file');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOTSUP') {
        t.skip(`filesystem symlink fixture unavailable on this host: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => mailbox.consumeResult(),
      /real regular file/u,
    );
  });
});

test('result consumption rejects junction or directory-link substitution where supported', async (t) => {
  await withRoot('pp-worker-exchange-junction-', async (root) => {
    const stateDirectory = path.join(root, 'state');
    const outsideDir = path.join(root, 'outside-dir');
    await mkdir(outsideDir, { mode: 0o700 });
    const exchange = new WorkerExchange({ stateDirectory });
    const mailbox = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: {} });
    await rm(mailbox.resultFile);
    try {
      await symlink(outsideDir, mailbox.resultFile, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOTSUP') {
        t.skip(`junction/directory-link fixture unavailable on this host: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => mailbox.consumeResult(),
      /real regular file/u,
    );
  });
});

test('control-plane result consumption detects context mutation without trusting applied state', async () => {
  await withRoot('pp-worker-exchange-context-', async (root) => {
    const stateDirectory = path.join(root, 'state');
    const exchange = new WorkerExchange({ stateDirectory });
    const mailbox = await exchange.prepareTurn({
      runId: 'run-1',
      turnId: 'turn-1',
      context: { objective: 'immutable context' },
    });
    await writeFile(mailbox.contextFile, '{"objective":"tampered"}\n', { encoding: 'utf8' });
    await assert.rejects(
      () => mailbox.consumeResult(),
      /modified its control-plane-owned context file/u,
    );
  });
});

test('control-plane result consumption enforces a bounded result size before parsing', async () => {
  await withRoot('pp-worker-exchange-size-', async (root) => {
    const exchange = new WorkerExchange({ stateDirectory: path.join(root, 'state') });
    const mailbox = await exchange.prepareTurn({ runId: 'run-1', turnId: 'turn-1', context: {} });
    await writeFile(mailbox.resultFile, 'x'.repeat(2048), { encoding: 'utf8' });
    const consumed = await mailbox.consumeResult({ maxBytes: 1024 });
    assert.equal(consumed.text, null);
    assert.equal(consumed.resultParseError, 'result file exceeds 1024 bytes');
  });
});
