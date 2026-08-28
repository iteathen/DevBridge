import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsImapiDataMediaWriter } from '../src/runtime/providers/windows-imapi-data-media.js';

function success(value = { created: true }) {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(value), stderr: '' };
}

test('IMAPI data-media writer stages an exact bounded tree and removes transient source bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-imapi-data-'));
  const calls = [];
  try {
    const destination = path.join(root, 'answer.iso');
    const writer = new WindowsImapiDataMediaWriter({
      invoke: async (request) => {
        calls.push(request);
        const payload = JSON.parse(request.input);
        assert.equal(await readFile(path.join(payload.source, 'Autounattend.xml'), 'utf8'), '<answer>transient</answer>');
        assert.equal(await readFile(path.join(payload.source, 'Setup', 'Prepare.ps1'), 'utf8'), 'Write-Output ready\n');
        await writeFile(payload.destination, 'iso-bytes');
        return success();
      },
    });
    const result = await writer.create({
      root,
      destination,
      volumeLabel: 'DB_SETUP',
      files: [
        { path: 'Autounattend.xml', content: '<answer>transient</answer>' },
        { path: 'Setup/Prepare.ps1', content: 'Write-Output ready\n' },
      ],
    });
    assert.equal(result.volumeLabel, 'DB_SETUP');
    assert.equal(result.fileCount, 2);
    assert.equal(result.bytes, 9);
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(calls[0].input.includes('transient'), false);
    const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
    assert.match(script, /VolumeName = \[string\]\$data\.volumeLabel/u);
    assert.match(script, /FileMode\.CreateNew/u);
    assert.deepEqual(await readdir(root), ['answer.iso']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('IMAPI data-media writer rejects ambiguous and escaping trees before platform effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-imapi-data-boundary-'));
  let calls = 0;
  try {
    const writer = new WindowsImapiDataMediaWriter({ invoke: async () => { calls += 1; return success(); } });
    const request = { root, destination: path.join(root, 'answer.iso'), volumeLabel: 'DB_SETUP' };
    await assert.rejects(() => writer.create({ ...request, files: [{ path: '../escape', content: 'x' }] }), /path is invalid/u);
    await assert.rejects(() => writer.create({ ...request, files: [{ path: 'Setup/file.ps1', content: 'x' }, { path: 'setup/FILE.ps1', content: 'y' }] }), /duplicates another entry/u);
    await assert.rejects(() => writer.create({ ...request, files: [{ path: 'CON', content: 'x' }] }), /path is invalid/u);
    await assert.rejects(() => writer.create({ ...request, files: [{ path: 'file', content: '' }] }), /content is invalid/u);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('IMAPI data-media writer keeps platform failures path-free', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-imapi-data-error-'));
  try {
    const destination = path.join(root, 'private-answer.iso');
    const writer = new WindowsImapiDataMediaWriter({
      invoke: async () => ({ ...success(), exitCode: 1, stderr: `failure at ${destination}` }),
    });
    await assert.rejects(
      () => writer.create({ root, destination, volumeLabel: 'DB_SETUP', files: [{ path: 'file', content: 'x' }] }),
      (error) => error.message === 'data media creation failed' && !error.message.includes(destination),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
