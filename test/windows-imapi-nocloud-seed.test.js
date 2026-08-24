import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCommand } from '../src/runtime/command-invocation.js';
import { WindowsImapiNoCloudSeedWriter } from '../src/runtime/providers/windows-imapi-nocloud-seed.js';

async function makeRoot() { return mkdtemp(path.join(os.tmpdir(), 'db-imapi-seed-')); }

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
    assert.match(script, /FileMode\.CreateNew/u);
    assert.match(script, /if \(created && File\.Exists\(destination\)\) File\.Delete\(destination\)/u);
    assert.doesNotMatch(script, /\$stream\.Read/u);
    assert.deepEqual(await readdir(root), ['cidata.iso']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows IMAPI seed writer copies the real early-bound image stream into a CIDATA image', { skip: process.platform !== 'win32' }, async () => {
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
