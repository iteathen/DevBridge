import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCommand } from '../src/runtime/command-invocation.js';
import { WindowsImapiNoCloudSeedWriter } from '../src/runtime/providers/windows-imapi-nocloud-seed.js';

async function makeRoot() { return mkdtemp(path.join(os.tmpdir(), 'db-imapi-seed-')); }

const ISO_SECTOR_BYTES = 2048;

function decodeUcs2Be(bytes) {
  let value = '';
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) value += String.fromCharCode(bytes.readUInt16BE(offset));
  return value.replace(/\0+$/u, '');
}

function inspectJolietRoot(image) {
  for (let sector = 16; (sector + 1) * ISO_SECTOR_BYTES <= image.length; sector += 1) {
    const descriptor = sector * ISO_SECTOR_BYTES;
    const type = image[descriptor];
    if (image.toString('ascii', descriptor + 1, descriptor + 6) !== 'CD001') continue;
    if (type === 255) break;
    const escape = image.subarray(descriptor + 88, descriptor + 91);
    if (type !== 2 || escape[0] !== 0x25 || escape[1] !== 0x2f || ![0x40, 0x43, 0x45].includes(escape[2])) continue;

    const rootRecord = descriptor + 156;
    const extent = image.readUInt32LE(rootRecord + 2);
    const bytes = image.readUInt32LE(rootRecord + 10);
    const start = extent * ISO_SECTOR_BYTES;
    if (bytes < 1 || start + bytes > image.length) throw new Error('Joliet root directory is outside the image');

    const root = image.subarray(start, start + bytes);
    const names = [];
    for (let offset = 0; offset < root.length;) {
      const recordBytes = root[offset];
      if (recordBytes === 0) {
        offset = (Math.floor(offset / ISO_SECTOR_BYTES) + 1) * ISO_SECTOR_BYTES;
        continue;
      }
      if (offset + recordBytes > root.length) throw new Error('Joliet root directory record is truncated');
      const nameBytes = root[offset + 32];
      const identifier = root.subarray(offset + 33, offset + 33 + nameBytes);
      if (!(nameBytes === 1 && (identifier[0] === 0 || identifier[0] === 1))) names.push(decodeUcs2Be(identifier).replace(/;1$/u, ''));
      offset += recordBytes;
    }
    return { volumeName: decodeUcs2Be(image.subarray(descriptor + 40, descriptor + 72)).trim(), names };
  }
  throw new Error('Joliet supplementary volume descriptor is absent');
}

test('Windows IMAPI seed writer stages only NoCloud files and removes secret-bearing staging', async () => {
  const root = await makeRoot();
  try {
    const destination = path.join(root, 'cidata.iso');
    const calls = [];
    const writer = new WindowsImapiNoCloudSeedWriter({
      invoke: async (request) => {
        calls.push(request);
        const payload = JSON.parse(request.input);
        assert.equal(await readFile(path.join(payload.source, 'user-data'), 'utf8'), '#cloud-config\nsecret: transient\n');
        assert.equal(await readFile(path.join(payload.source, 'meta-data'), 'utf8'), 'instance-id: image-build\n');
        await writeFile(payload.destination, 'iso-bytes');
        return { exitCode: 0, stdout: '{"created":true}', stderr: '', timedOut: false, aborted: false, outputTruncated: false };
      },
    });
    const result = await writer.create({
      root,
      destination,
      userData: '#cloud-config\nsecret: transient',
      metaData: 'instance-id: image-build',
    });
    assert.equal(result.volumeLabel, 'CIDATA');
    assert.equal(result.bytes, 9);
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(calls[0].executable, 'powershell.exe');
    assert.equal(calls[0].input.includes('transient'), false);
    const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
    assert.match(script, /System\.Runtime\.InteropServices\.ComTypes/u);
    assert.match(script, /IStream stream = \(IStream\)source/u);
    assert.match(script, /FileSystemsToCreate = 3/u);
    assert.match(script, /FileMode\.CreateNew/u);
    assert.match(script, /if \(created && File\.Exists\(destination\)\) File\.Delete\(destination\)/u);
    assert.doesNotMatch(script, /\$stream\.Read/u);
    assert.deepEqual(await readdir(root), ['cidata.iso']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows IMAPI seed writer copies a real ISO9660 and Joliet CIDATA image with exact NoCloud names', { skip: process.platform !== 'win32' }, async () => {
  const root = await makeRoot();
  try {
    const destination = path.join(root, 'cidata.iso');
    const writer = new WindowsImapiNoCloudSeedWriter({ invoke: invokeCommand });
    const result = await writer.create({
      root,
      destination,
      userData: '#cloud-config\nusers: []',
      metaData: 'instance-id: imapi-stream-regression',
    });
    const image = await readFile(destination);
    assert.ok(result.bytes > 0);
    assert.equal(result.bytes, image.length);
    assert.equal(image.includes(Buffer.from('CIDATA', 'ascii')), true);
    const joliet = inspectJolietRoot(image);
    assert.equal(joliet.volumeName, 'CIDATA');
    assert.deepEqual([...joliet.names].sort(), ['meta-data', 'user-data']);
    assert.deepEqual(await readdir(root), ['cidata.iso']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows IMAPI seed writer refuses destinations outside its owned root', async () => {
  const root = await makeRoot();
  try {
    let invoked = false;
    const writer = new WindowsImapiNoCloudSeedWriter({ invoke: async () => { invoked = true; } });
    await assert.rejects(() => writer.create({
      root,
      destination: path.join(path.dirname(root), 'foreign.iso'),
      userData: '#cloud-config',
      metaData: 'instance-id: build',
    }), /inside the owned root/u);
    assert.equal(invoked, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
