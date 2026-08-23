import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsImapiNoCloudSeedWriter } from '../src/runtime/providers/windows-imapi-nocloud-seed.js';

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-imapi-seed-')); }

test('Windows IMAPI seed writer stages only NoCloud files and removes secret-bearing staging', async () => {
  const workspace = await root();
  try {
    const destination = path.join(workspace, 'cidata.iso');
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
      workspace,
      destination,
      userData: '#cloud-config\nsecret: transient',
      metaData: 'instance-id: image-build',
    });
    assert.equal(result.volumeLabel, 'CIDATA');
    assert.equal(result.bytes, 9);
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(calls[0].executable, 'powershell.exe');
    assert.equal(calls[0].input.includes('transient'), false);
    assert.deepEqual(await readdir(workspace), ['cidata.iso']);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('Windows IMAPI seed writer refuses destinations outside its owned workspace', async () => {
  const workspace = await root();
  try {
    let invoked = false;
    const writer = new WindowsImapiNoCloudSeedWriter({ invoke: async () => { invoked = true; } });
    await assert.rejects(() => writer.create({
      workspace,
      destination: path.join(path.dirname(workspace), 'foreign.iso'),
      userData: '#cloud-config',
      metaData: 'instance-id: build',
    }), /inside the owned workspace/u);
    assert.equal(invoked, false);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
