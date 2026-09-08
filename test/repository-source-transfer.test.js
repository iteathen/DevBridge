import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotFileTree } from '../src/runtime/file-tree-transfer.js';
import { transferRepositorySource } from '../src/app/repository-execution/source-transfer.js';

const agent = fileURLToPath(new URL('../src/guest/workspace-agent.mjs', import.meta.url));
const packAgent = fileURLToPath(new URL('../src/guest/source-pack-agent.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
function run(cwd, args, executable = agent) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', bytes => { out += bytes; });
    child.stderr.on('data', bytes => { err += bytes; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, out, err }));
  });
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-source-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), input = path.join(root, 'input'), work = path.join(root, 'work');
  await Promise.all([mkdir(source), mkdir(input), mkdir(work)]);
  return { root, source, input, work, pack: path.join(input, 'parts.gz') };
}

test('consumer packs many files and actual guest provider applies the exact original manifest', async t => {
  const f = await fixture(t);
  const content = new Map(Array.from({ length: 360 }, (_, i) => [`source-${i}.txt`, Buffer.from(`int value_${i} = ${i};\n`.repeat(8))]));
  content.set('empty.txt', Buffer.alloc(0));
  content.set('binary.dat', randomBytes(32768));
  await Promise.all([...content].map(([name, bytes]) => writeFile(path.join(f.source, name), bytes)));
  const snapshot = await snapshotFileTree({ root: f.source, listPaths: async () => [...content.keys()] });
  let packs = 0, compressedBytes = 0;
  await transferRepositorySource({
    snapshot,
    writePack: async bytes => { packs += 1; compressedBytes += bytes.length; await writeFile(f.pack, bytes); },
    unpack: async identity => {
      const result = await run(f.work, [f.pack, identity], packAgent);
      assert.equal(result.code, 0, result.err);
      return JSON.parse(result.out);
    },
    writePart: () => assert.fail('small parts should use the packed transport'),
  });
  assert.equal(packs, 1);
  assert.ok(compressedBytes < snapshot.manifest.totalBytes);
  await assert.rejects(readFile(f.pack), { code: 'ENOENT' });
  const manifestFile = path.join(f.input, 'manifest.json');
  await writeFile(manifestFile, snapshot.manifestBytes());
  const applied = await run(f.work, ['apply', manifestFile, path.join(f.root, 'state.json')]);
  assert.equal(applied.code, 0, applied.err);
  assert.equal(JSON.parse(applied.out).digest, snapshot.manifest.digest);
  for (const [name, bytes] of content) assert.deepEqual(await readFile(path.join(f.work, name)), bytes);
});

test('source transfer bounds packs, streams large parts, and rejects changed source and receipts', async t => {
  const f = await fixture(t);
  const small = Buffer.alloc(1024 * 1024, 'a'), large = Buffer.alloc(3 * 1024 * 1024, 'b');
  await writeFile(path.join(f.source, 'small-a'), small);
  await writeFile(path.join(f.source, 'small-b'), small);
  await writeFile(path.join(f.source, 'large'), large);
  const snapshot = await snapshotFileTree({ root: f.source, listPaths: async () => ['small-a', 'small-b', 'large'] });
  let packed, raw = 0;
  const ports = {
    snapshot,
    writePack: async bytes => { packed = JSON.parse(gunzipSync(bytes).toString()); },
    unpack: async identity => ({ ready: true, digest: identity, parts: packed.parts.length }),
    writePart: async (part, read) => { raw += 1; const response = await read({ offset: 0, limit: part.size }); assert.deepEqual(response.data, large); },
  };
  await transferRepositorySource(ports);
  assert.equal(raw, 1);
  assert.equal(packed.parts.length, 2);
  await assert.rejects(transferRepositorySource({ ...ports, unpack: async () => ({ ready: true, digest: '0'.repeat(64), parts: 2 }) }), /receipt does not match/);
  await writeFile(path.join(f.source, 'small-a'), 'changed');
  await assert.rejects(transferRepositorySource(ports), /source part changed/);
});

test('cancellation after pack delivery prevents unpack and subsequent effects', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'a'), 'a');
  const snapshot = await snapshotFileTree({ root: f.source, listPaths: async () => ['a'] });
  const controller = new AbortController();
  await assert.rejects(transferRepositorySource({ snapshot, signal: controller.signal,
    writePack: async () => controller.abort(new Error('lease lost')),
    unpack: () => assert.fail('cancelled transfer cannot unpack'), writePart: () => assert.fail('unexpected raw transfer'),
  }), /lease lost/);
});

test('source progress uses the run liveness contract and awaits checkpointing before effects', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'a'), 'a');
  const snapshot = await snapshotFileTree({ root: f.source, listPaths: async () => ['a'] });
  const events = [];
  let checkpointed = false;
  await transferRepositorySource({ snapshot,
    onActivity: async event => { await Promise.resolve(); events.push(event.kind); checkpointed = true; },
    writePack: async (_bytes, controls) => { assert.equal(checkpointed, true); await controls.onProgress({ offset: 0, total: 123 }); },
    unpack: async digest => ({ ready: true, digest, parts: 1 }),
    writePart: () => assert.fail('unexpected raw transfer'),
  });
  assert.deepEqual(events, ['source-transfer 0/1 parts', 'source-transfer 0/1 parts; pack 0/123 bytes', 'source-transfer 1/1 parts']);
  await assert.rejects(transferRepositorySource({ snapshot,
    onActivity: async () => { throw new Error('checkpoint failed'); },
    writePack: () => assert.fail('effect cannot precede accepted progress'),
  }), /checkpoint failed/);
});

test('guest rejects forged digest, traversal, duplicates, invalid bytes and decompression overflow before writing parts', async t => {
  const f = await fixture(t);
  const member = { name: 'part-0-0', size: 1, digest: hash('a'), data: Buffer.from('a').toString('base64') };
  const payload = parts => Buffer.from(JSON.stringify({ protocol: 'devbridge/source-part-pack-v1', parts }));
  const cases = [
    { bytes: gzipSync(payload([member])), expected: '0'.repeat(64) },
    { bytes: gzipSync(payload([{ ...member, name: '../escaped' }])) },
    { bytes: gzipSync(payload([member, member])) },
    { bytes: gzipSync(payload([{ ...member, data: 'Yg==' }])) },
    { bytes: gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1, 'a')) },
  ];
  for (const item of cases) {
    await writeFile(f.pack, item.bytes);
    const result = await run(f.work, [f.pack, item.expected ?? hash(item.bytes)], packAgent);
    assert.notEqual(result.code, 0);
    assert.deepEqual(await readdir(f.input), ['parts.gz']);
  }
});

test('partial guest staging can resume the same pack without changing repository state', async t => {
  const f = await fixture(t);
  const parts = ['alpha', 'beta'].map((value, index) => ({ name: `part-${index}-0`, size: value.length, digest: hash(value), data: Buffer.from(value).toString('base64') }));
  const bytes = gzipSync(Buffer.from(JSON.stringify({ protocol: 'devbridge/source-part-pack-v1', parts })));
  const identity = hash(bytes);
  await writeFile(f.pack, bytes);
  await writeFile(path.join(f.work, 'retained.txt'), 'unchanged repository');
  // An incompatible second destination interrupts staging after the first
  // atomic part write. The original pack remains available for reconciliation.
  await mkdir(path.join(f.input, 'part-1-0'));
  const interrupted = await run(f.work, [f.pack, identity], packAgent);
  assert.notEqual(interrupted.code, 0);
  assert.equal(await readFile(path.join(f.input, 'part-0-0'), 'utf8'), 'alpha');
  assert.deepEqual(await readFile(f.pack), bytes);
  assert.equal(await readFile(path.join(f.work, 'retained.txt'), 'utf8'), 'unchanged repository');
  await rm(path.join(f.input, 'part-1-0'), { recursive: true });
  const resumed = await run(f.work, [f.pack, identity], packAgent);
  assert.equal(resumed.code, 0, resumed.err);
  assert.deepEqual(JSON.parse(resumed.out), { ready: true, digest: identity, parts: 2 });
  assert.equal(await readFile(path.join(f.input, 'part-1-0'), 'utf8'), 'beta');
  assert.deepEqual(await readdir(f.work), ['retained.txt']);
});
