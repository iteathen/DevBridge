import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WindowsImapiDataMediaWriter } from '../src/runtime/providers/windows-imapi-data-media.js';

function success(value = { created: true }) {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(value), stderr: '' };
}

test('exact-file media admits binary bytes and long original names without copying input trees', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-imapi-files-'));
  try {
    const bytes = Buffer.from([0, 255, 17, 0, 42]);
    const location = path.join(root, 'source.bin');
    await writeFile(location, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let calls = 0;
    const writer = new WindowsImapiDataMediaWriter({ invoke: async (request) => {
      calls++;
      const data = JSON.parse(request.input);
      assert.equal(data.files[0].source.location, location);
      assert.equal(data.files[0].source.sha256, sha256);
      assert.equal(data.files[0].path, `pool/${'a'.repeat(99)}.deb`);
      assert.equal(data.maximumImageBytes, 8 * 1024 * 1024);
      assert.equal(data.fileSystems, 4);
      assert.equal(data.source, undefined);
      assert.equal(data.files[0].content, undefined);
      await writeFile(data.destination, 'verified-media');
      return success();
    } });
    const request = { root, destination: path.join(root, 'data.iso'), volumeLabel: 'DB_PACKAGES',
      maximumImageBytes: 8 * 1024 * 1024, timeoutMs: 10000,
      files: [{ path: `pool/${'a'.repeat(99)}.deb`, source: { location, size: bytes.length, sha256 } }] };
    const result = await writer.createFiles(request);
    assert.equal(result.fileSystem, 'udf');
    assert.equal(result.fileCount, 1);
    assert.equal(calls, 1);
    assert.deepEqual((await readdir(root)).sort(), ['data.iso', 'source.bin']);
    await assert.rejects(writer.createFiles(request), /already exists/);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exact-file media rejects invalid subjects, bytes and contradictory paths before platform effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-imapi-files-denial-'));
  try {
    const location = path.join(root, 'source.bin'); await writeFile(location, 'input');
    const source = { location, size: 5, sha256: createHash('sha256').update('input').digest('hex') };
    let calls = 0;
    const writer = new WindowsImapiDataMediaWriter({ invoke: async () => { calls++; return success(); } });
    const base = { root, destination: path.join(root, 'data.iso'), volumeLabel: 'DB_PACKAGES', maximumImageBytes: 8 * 1024 * 1024, timeoutMs: 10000, files: [{ path: 'file', source }] };
    for (const request of [
      { ...base, maximumImageBytes: 0 }, { ...base, maximumImageBytes: 2048 },
      { ...base, timeoutMs: Infinity }, { ...base, shell: true },
      { ...base, files: [{ path: '../escape', source }] },
      { ...base, files: [{ path: 'a', source }, { path: 'A/b', source }] },
      { ...base, files: [{ path: 'a/b', source }, { path: 'A', source }] },
      { ...base, files: [{ path: 'a/b', source }, { path: 'a/B', source }] },
      { ...base, files: [{ path: 'file', source: { ...source, sha256: 'f'.repeat(64) } }] },
    ]) await assert.rejects(writer.createFiles(request));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(writer.createFiles({ ...base, signal: controller.signal }));
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(root), ['source.bin']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exact-file media rejects late replacement, preserves foreign output and stays retryable after failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-imapi-files-recovery-'));
  try {
    const location = path.join(root, 'source.bin'); await writeFile(location, 'input');
    const source = { location, size: 5, sha256: createHash('sha256').update('input').digest('hex') };
    const base = { root, destination: path.join(root, 'data.iso'), volumeLabel: 'DB_PACKAGES', maximumImageBytes: 8 * 1024 * 1024, timeoutMs: 10000, files: [{ path: 'file', source }] };
    let mode = 'failure';
    const controller = new AbortController();
    const writer = new WindowsImapiDataMediaWriter({ invoke: async ({ input }) => {
      const data = JSON.parse(input); await writeFile(data.destination, 'media');
      if (mode === 'failure') return { ...success(), exitCode: 1 };
      if (mode === 'changed') { await rm(location); await writeFile(location, 'input'); }
      if (mode === 'foreign') await writeFile(base.destination, 'foreign');
      if (mode === 'abort') controller.abort();
      return success();
    } });
    await assert.rejects(writer.createFiles(base), /creation failed/);
    assert.deepEqual(await readdir(root), ['source.bin']);
    mode = 'changed'; await assert.rejects(writer.createFiles(base), /identity changed/);
    assert.deepEqual(await readdir(root), ['source.bin']);
    mode = 'abort'; await assert.rejects(writer.createFiles({ ...base, signal: controller.signal }));
    assert.deepEqual(await readdir(root), ['source.bin']);
    mode = 'foreign'; await assert.rejects(writer.createFiles(base), /EEXIST/);
    assert.equal(await readFile(base.destination, 'utf8'), 'foreign');
    await rm(base.destination);
    mode = 'success'; assert.equal((await writer.createFiles(base)).bytes, 5);
    assert.deepEqual((await readdir(root)).sort(), ['data.iso', 'source.bin']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
