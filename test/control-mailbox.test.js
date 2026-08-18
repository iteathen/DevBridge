import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ControlMailboxStore } from '../src/runtime/control-mailbox.js';

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pp-mailbox-test-'));
  const root = path.join(parent, 'mailboxes');
  return { parent, root, store: new ControlMailboxStore({ root }) };
}

test('control mailbox lives outside the project and bounds context/result files', async () => {
  const { root, store } = await fixture();
  const mailbox = await store.create({ runId: 'run-1', turn: 1 });
  await store.writeContext(mailbox, { objective: 'fixture' });
  await writeFile(mailbox.resultFile, '{"protocol":"patch-poller/result-v1","status":"complete","summary":"ok"}', { mode: 0o600 });

  assert.ok(mailbox.directory.startsWith(path.resolve(root)));
  assert.deepEqual(JSON.parse(await readFile(mailbox.contextFile, 'utf8')), { objective: 'fixture' });
  assert.match(await store.readResult(mailbox), /patch-poller\/result-v1/u);
  await store.remove(mailbox);
  assert.equal(await store.readResult(mailbox).catch((error) => error?.code ?? error.name), 'ENOENT');
});

test('result mailbox rejects symlink substitution instead of following worker-controlled links', { skip: process.platform === 'win32' }, async () => {
  const { parent, store } = await fixture();
  const mailbox = await store.create({ runId: 'run-2', turn: 1 });
  const outside = path.join(parent, 'outside-secret.txt');
  await writeFile(outside, 'outside-secret', { mode: 0o600 });
  await symlink(outside, mailbox.resultFile);

  await assert.rejects(store.readResult(mailbox), /regular non-link file/u);
  assert.equal(await readFile(outside, 'utf8'), 'outside-secret');
});
