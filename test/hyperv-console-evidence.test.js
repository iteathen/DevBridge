import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HyperVConsoleEvidence } from '../src/runtime/providers/hyperv-image-construction/console-evidence.js';
import { HyperVConstructionChannel } from '../src/runtime/providers/hyperv-image-construction/management-channel.js';

test('console channel defaults compatibly and bounds native output for readable dimensions', async () => {
  const requests = [];
  const channel = new HyperVConstructionChannel({ invoke: async (request) => {
    requests.push(request);
    return { exitCode: 0, stdout: '{"available":false,"reason":"off"}' };
  } });
  await channel.console({ name: 'fixture', providerIdentity: 'id' });
  await channel.console({ name: 'fixture', providerIdentity: 'id', width: 1024, height: 768 });
  assert.equal(JSON.parse(requests[0].input).width, 320);
  assert.equal(JSON.parse(requests[1].input).height, 768);
  assert.ok(requests[1].maxOutputBytes > 1024 * 768 * 2 * 4 / 3);
  assert.ok(requests[1].maxOutputBytes < 3 * 1024 * 1024);
  for (const size of [[65535, 65535], [320, 768], ['320', 240]]) {
    assert.throws(() => channel.console({ width: size[0], height: size[1] }), /unsupported/u);
  }
  assert.equal(requests.length, 2);
});

test('console evidence decodes RGB565 at each supported size with exact bounds', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-console-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new HyperVConsoleEvidence({ directory, now: () => new Date('2026-09-08T00:00:00Z') });
  for (const [width, height] of [[320, 240], [640, 480], [1024, 768]]) {
    const pixels = Buffer.alloc(width * height * 2);
    pixels.writeUInt16LE(0xf800, 0);
    pixels.writeUInt16LE(0x07e0, 2);
    pixels.writeUInt16LE(0x001f, pixels.length - 2);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(pixels.length + 4);
    for (const bytes of [pixels, Buffer.concat([prefix, pixels])]) {
      const published = await owner.publish(`fixture-${width}`, { available: true, width, height, imageData: bytes.toString('base64') });
      const bmp = await readFile(published.location);
      assert.equal(bmp.readInt32LE(18), width);
      assert.equal(bmp.readInt32LE(22), -height);
      assert.deepEqual([...bmp.subarray(54, 60)], [0, 0, 255, 0, 255, 0]);
      assert.deepEqual([...bmp.subarray(-3)], [255, 0, 0]);
      assert.equal(bmp.length, 54 + width * height * 3);
    }
    await assert.rejects(owner.publish('bad', { available: true, width, height, imageData: pixels.subarray(2).toString('base64') }), /size/u);
  }
  await assert.rejects(owner.publish('bad', { available: true, width: 65535, height: 65535, imageData: 'AAAA' }), /unsupported/u);
  assert.deepEqual(await owner.publish('off', { available: false, reason: 'guest is off' }), { available: false, reason: 'guest is off' });
});
