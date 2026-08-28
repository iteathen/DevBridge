import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTransferChannel } from '../src/guest/transfer-channel.mjs';

const identity = 'a'.repeat(32);
const binding = 'scope-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-transfer-channel-'));
  const records = path.join(root, 'records');
  const files = path.join(root, 'files');
  await mkdir(records);
  await mkdir(files);
  const normalize = (value) => {
    assert.deepEqual(Object.keys(value).sort(), ['name']);
    if (!/^[a-z0-9.-]+$/u.test(value.name)) throw new Error('location value is invalid');
    return { name: value.name };
  };
  const resolve = async (value) => ({ root: files, path: path.join(files, value.name) });
  return {
    root,
    files,
    channel: await createTransferChannel({
      directory: records,
      normalizeWrite: normalize,
      resolveWrite: resolve,
      normalizeRead: normalize,
      resolveRead: resolve,
    }),
  };
}

test('transfer channel stages, replays, finalizes, and reads exact bytes', async () => {
  const { root, files, channel } = await fixture();
  const bytes = Buffer.from('nested-transfer');
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    const first = { destination: { name: 'payload.bin' }, offset: 0, data: bytes.subarray(0, 6).toString('base64'), eof: false, digest: null };
    assert.deepEqual(await channel.put({ identity, binding, value: first }), { nextOffset: 6, complete: false, digest: null });
    assert.deepEqual(await channel.put({ identity, binding, value: first }), { nextOffset: 6, complete: false, digest: null });
    const last = { destination: { name: 'payload.bin' }, offset: 6, data: bytes.subarray(6).toString('base64'), eof: true, digest };
    assert.deepEqual(await channel.put({ identity, binding, value: last }), { nextOffset: bytes.length, complete: true, digest });
    assert.equal(await readFile(path.join(files, 'payload.bin'), 'utf8'), 'nested-transfer');
    const read = await channel.get({ identity: 'b'.repeat(32), binding, value: { source: { name: 'payload.bin' }, offset: 0, limit: 1024 } });
    assert.equal(Buffer.from(read.data, 'base64').toString('utf8'), 'nested-transfer');
    assert.equal(read.eof, true);
    assert.equal(read.digest, digest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('transfer identity and binding cannot be reused across another destination or scope', async () => {
  const { root, channel } = await fixture();
  try {
    const value = { destination: { name: 'one.bin' }, offset: 0, data: 'YQ==', eof: false, digest: null };
    await channel.put({ identity, binding, value });
    await assert.rejects(() => channel.put({ identity, binding: 'scope-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', value }), /identity changed/u);
    await assert.rejects(() => channel.put({ identity, binding, value: { ...value, destination: { name: 'two.bin' } } }), /identity changed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('transfer channel rejects widened frames and a resolver boundary escape', async () => {
  const { root, channel } = await fixture();
  try {
    await assert.rejects(() => channel.get({ identity, binding, value: { source: { name: 'x' }, offset: 0, limit: 1, process: 'foreign' } }), /process is not allowed/u);
    const outside = await createTransferChannel({
      directory: path.join(root, 'records'),
      normalizeWrite: (value) => value,
      resolveWrite: async () => ({ root: path.join(root, 'files'), path: path.join(root, 'escape.bin') }),
      normalizeRead: (value) => value,
      resolveRead: async () => ({ root: path.join(root, 'files'), path: path.join(root, 'escape.bin') }),
    });
    await assert.rejects(() => outside.get({ identity, binding, value: { source: { name: 'x' }, offset: 0, limit: 1 } }), /escaped its boundary/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
