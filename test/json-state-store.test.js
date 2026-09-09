import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/state/json-state-store.js';
import { createJsonRecordFile } from '../src/state/json-record-file.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-state-replace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  await writeFile(file, '{"previous":true}\n');
  return file;
}

test('state commits serialize, share initial loading and keep failed mutations out of later saves', async () => {
  let reads = 0, fail = true, disk = { old: 1 };
  const store = new JsonStateStore('fixture', { file: {
    read: async () => { reads++; return structuredClone(disk); },
    replace: async next => { if (fail) throw new Error('replacement unavailable'); disk = structuredClone(next); },
  } });
  await assert.rejects(store.set('failed', 2), /replacement unavailable/);
  assert.equal(await store.get('failed'), undefined);
  fail = false;
  await Promise.all([store.set('a', { value: 3 }), store.set('b', 4), store.delete('old')]);
  assert.deepEqual(disk, { a: { value: 3 }, b: 4 });
  const a = await store.get('a'); a.value = 99;
  assert.deepEqual(await store.entries(), [['a', { value: 3 }], ['b', 4]]);
  assert.equal(reads, 1);
});

test('replacement observes a lost success response without replaying its effect', async t => {
  const file = await fixture(t); let calls = 0;
  const owner = createJsonRecordFile(file, { platform: 'win32', renameFile: async (...args) => {
    calls++; await rename(...args); throw Object.assign(new Error('response lost'), { code: 'EPERM' });
  } });
  await owner.replace({ next: 1 });
  assert.deepEqual(await owner.read(), { next: 1 });
  assert.equal(calls, 1);
});

test('replacement bounds Windows sharing retries and leaves permanent failures unchanged', async t => {
  const file = await fixture(t); let calls = 0; const waits = [];
  const owner = createJsonRecordFile(file, { platform: 'win32', wait: async ms => waits.push(ms), renameFile: async () => {
    calls++; throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
  } });
  await assert.rejects(owner.replace({ next: 1 }), /sharing violation/);
  assert.equal(calls, 5); assert.deepEqual(waits, [25, 75, 150, 300]);
  assert.deepEqual(await owner.read(), { previous: true });
  calls = 0;
  const permanent = createJsonRecordFile(file, { platform: 'win32', renameFile: async () => {
    calls++; throw Object.assign(new Error('invalid operation'), { code: 'EINVAL' });
  } });
  await assert.rejects(permanent.replace({ next: 1 }), /invalid operation/);
  assert.equal(calls, 1);
});

test('replacement refuses to overwrite a different committed value during recovery', async t => {
  const file = await fixture(t); let calls = 0;
  const owner = createJsonRecordFile(file, { platform: 'win32', renameFile: async () => {
    calls++; await writeFile(file, '{"other":true}\n');
    throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
  } });
  await assert.rejects(owner.replace({ next: 1 }), /changed during interrupted replacement/);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { other: true });
});

test('Windows replacement survives a native handle temporarily denying delete sharing', { skip: process.platform !== 'win32', timeout: 15_000 }, async t => {
  const file = await fixture(t);
  const code = String.raw`$ErrorActionPreference='Stop'; $file=[Console]::ReadLine(); $handle=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null } finally { $handle.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  const closed = once(child, 'close');
  const ready = once(child.stdout, 'data');
  child.stdin.write(`${file}\n`);
  assert.equal(String((await ready)[0]).trim(), 'ready');
  let retries = 0;
  const owner = createJsonRecordFile(file, { wait: async () => {
    retries++; child.stdin.end('\n'); assert.equal((await closed)[0], 0);
  } });
  await owner.replace({ next: 1 });
  assert.equal(retries, 1);
  assert.deepEqual(await owner.read(), { next: 1 });
});
