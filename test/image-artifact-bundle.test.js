import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildImageArtifactBundle } from '../src/runtime/image-artifact-bundle.js';

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-image-bundle-')); }
function framedCodec(events) { return { async describe() { return { algorithm: 'test-frame', parameters: { version: '1' } }; }, async encode({ source, destination }) { events.push('encode-start'); const bytes = await readFile(source); await writeFile(destination, Buffer.concat([Buffer.from('ENC['), bytes, Buffer.from(']END')])); events.push('encode-complete'); } }; }
function passthroughCodec() { return { async describe() { return { algorithm: 'test-passthrough', parameters: { version: '1' } }; }, async encode({ source, destination }) { await writeFile(destination, await readFile(source)); } }; }
function denseBytes(size) { const bytes = Buffer.alloc(size); let state = 0x13579bdf; for (let index = 0; index < bytes.length; index += 1) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[index] = state & 0xff; } return bytes; }

test('bundle encodes one whole canonical stream before transport chunking', async () => {
  const parent = await root();
  try { const canonical = path.join(parent, 'base.vhdx'); const destination = path.join(parent, 'bundle'); const content = Buffer.from('0123456789abcdef'); await writeFile(canonical, content); const events = [];
    const result = await buildImageArtifactBundle({ canonical, destination, profile: 'linux-development', generation: 'ubuntu-v1', format: 'vhdx', virtualSize: 4096, bootstrap: 'tooling-v1', codec: framedCodec(events), chunkBytes: 7 });
    assert.deepEqual(events, ['encode-start', 'encode-complete']); assert.ok(result.manifest.chunks.length > 1);
    const chunkBytes = await Promise.all(result.chunkNames.map((name) => readFile(path.join(destination, name))));
    assert.deepEqual(Buffer.concat(chunkBytes), Buffer.concat([Buffer.from('ENC['), content, Buffer.from(']END')]));
    assert.equal((await readdir(destination)).some((name) => name.startsWith('.encoded-')), false); assert.match(result.manifestDigest, /^[a-f0-9]{64}$/u);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('bundle preserves logical bytes across a large sparse image with a dense region', async () => {
  const parent = await root();
  try {
    const canonical = path.join(parent, 'mixed.img');
    const destination = path.join(parent, 'bundle');
    const logicalSize = 16 * 1024 * 1024;
    const dense = denseBytes(128 * 1024);
    const denseOffset = 9 * 1024 * 1024 + 37;
    const handle = await open(canonical, 'w', 0o600);
    try {
      await handle.truncate(logicalSize);
      await handle.write(dense, 0, dense.length, denseOffset);
      await handle.sync();
    } finally { await handle.close(); }

    const expected = await readFile(canonical);
    const result = await buildImageArtifactBundle({
      canonical,
      destination,
      profile: 'mixed-profile',
      generation: 'generation-v1',
      format: 'image',
      virtualSize: logicalSize,
      bootstrap: 'tooling-v1',
      codec: passthroughCodec(),
      chunkBytes: 1024 * 1024,
    });
    const chunks = await Promise.all(result.chunkNames.map((name) => readFile(path.join(destination, name))));
    assert.equal(result.manifest.image.size, logicalSize);
    assert.equal(result.manifest.encoding.size, logicalSize);
    assert.equal(result.manifest.chunks.length, 16);
    assert.deepEqual(Buffer.concat(chunks), expected);
    assert.deepEqual(expected.subarray(denseOffset, denseOffset + dense.length), dense);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('bundle refuses a pre-existing destination rather than cleaning caller data', async () => {
  const parent = await root();
  try { const canonical = path.join(parent, 'base.img'); const destination = path.join(parent, 'bundle'); await writeFile(canonical, 'canonical'); await writeFile(destination, 'caller-owned');
    await assert.rejects(() => buildImageArtifactBundle({ canonical, destination, profile: 'p', generation: 'g', format: 'img', virtualSize: 9, bootstrap: 'b', codec: framedCodec([]), chunkBytes: 4 }), /already exists/u);
    assert.equal(await readFile(destination, 'utf8'), 'caller-owned');
  } finally { await rm(parent, { recursive: true, force: true }); }
});
